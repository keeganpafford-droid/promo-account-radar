import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { validateSignupProfile } from './lib/signup-validation.js';
import { verifyTurnstileToken } from './lib/turnstile.js';
// House Accounts Auth API. Uses Supabase Auth + existing ha_users / ha_organizations tables.
function json(res,status,body){return res.status(status).json(body)}
function clean(v=''){return String(v||'').trim()}
function lower(v=''){return clean(v).toLowerCase()}
function appBaseUrl(req){
  const configured=clean(process.env.APP_BASE_URL);
  if(configured)return configured.replace(/\/+$/,'');
  const host=clean(req?.headers?.host);
  const isLocal=/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  if(isLocal)return `http://${host}`;
  return 'https://www.houseaccounts.ai';
}
function planConfig(planRaw){const plan=clean(planRaw||'free').toLowerCase();if(plan==='solo')return{plan:'solo',seat_limit:1};if(plan==='team')return{plan:'team',seat_limit:25};if(plan==='enterprise')return{plan:'enterprise',seat_limit:null};return{plan:'free',seat_limit:1}}
// 2026-08-13 pricing decision: no new 30-day paid-capacity trials are
// granted going forward. Free (up to 10 monitored accounts, no credit
// card) is the only no-payment entry point now; paid capacity is
// purchased through Stripe Checkout (api/create-checkout-session.js), not
// a signup-time trial grant. A signup requesting plan 'solo'/'team' still
// gets that plan value recorded (harmless, matches planConfig()'s
// seat_limit for historical consistency) but no trial -- entitlement()
// correctly treats it as free-limited until a real Stripe subscription
// exists. Existing Beta orgs already mid-trial are unaffected: nothing
// here touches an existing organization row, only new-org creation.
function orgDefaults(planRaw){const cfg=planConfig(planRaw);if(cfg.plan==='enterprise'){return{...cfg,trial_status:'inactive',subscription_status:'manual',trial_started_at:null,trial_end:null,trial_used:false}}return{...cfg,trial_status:'inactive',subscription_status:'inactive',trial_started_at:null,trial_end:null,trial_used:false}}
function env(){const rawUrl=process.env.SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!rawUrl||!key)throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');const url=String(rawUrl).trim().replace(/\/+$/,'').replace(/\/rest\/v1$/i,'');return{url,key}}
async function sb(path, options={}){const{url,key}=env();const resp=await fetch(`${url}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:options.prefer||'return=representation',...(options.headers||{})}});const text=await resp.text();let data=null;if(text){try{data=JSON.parse(text)}catch{data=text}}if(!resp.ok){const msg=typeof data==='string'?data:(data?.message||data?.hint||JSON.stringify(data));throw new Error(`Supabase ${resp.status}: ${msg}`)}return data}
async function authFetch(path, options={}){const{url,key}=env();const resp=await fetch(`${url}/auth/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...(options.headers||{})}});const text=await resp.text();let data={};if(text){try{data=JSON.parse(text)}catch{data={raw:text}}}if(!resp.ok){throw new Error(data.error_description||data.msg||data.error||data.message||`Supabase Auth ${resp.status}`)}return data}
async function getAuthUser(accessToken){if(!accessToken)return null;try{return await authFetch('user',{method:'GET',headers:{Authorization:`Bearer ${accessToken}`}})}catch{return null}}
async function getHaUserByAuth(authUserId){const rows=await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=*&limit=1`,{method:'GET'});return Array.isArray(rows)?rows[0]:null}
async function getHaUserByEmail(email){const rows=await sb(`ha_users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`,{method:'GET'});return Array.isArray(rows)?rows[0]:null}
async function ensureOrgAndUser(authUser, profile={}){const email=lower(authUser?.email||profile.email);if(!email)throw new Error('Missing auth email');let user=authUser?.id?await getHaUserByAuth(authUser.id):null;if(!user)user=await getHaUserByEmail(email);let orgId=user?.organization_id||'';if(!orgId){const orgName=clean(profile.organizationName||profile.company||user?.company||email.split('@')[1]||'New Organization');const cfg=orgDefaults(profile.plan);const inserted=await sb('ha_organizations',{method:'POST',body:JSON.stringify([{name:orgName,plan:cfg.plan,trial_status:cfg.trial_status,subscription_status:cfg.subscription_status,trial_started_at:cfg.trial_started_at,trial_end:cfg.trial_end,trial_used:cfg.trial_used,seat_limit:cfg.seat_limit,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}])});const org=Array.isArray(inserted)?inserted[0]:inserted;orgId=org?.id;if(!orgId)throw new Error('Organization create did not return an id.');}
const row={email,name:clean(profile.name||user?.name||authUser?.user_metadata?.name),company:clean(profile.organizationName||profile.company||user?.company),role:clean(profile.role||user?.role),house_accounts:clean(profile.house_accounts||profile.houseAccounts||user?.house_accounts),crm_erp:clean(profile.crm_erp||profile.crmErp||user?.crm_erp),auth_user_id:authUser.id,organization_id:orgId,app_role:user?.app_role||'owner',status:'active',updated_at:new Date().toISOString()};
if(user?.id){const updated=await sb(`ha_users?id=eq.${encodeURIComponent(user.id)}`,{method:'PATCH',body:JSON.stringify(row)});return Array.isArray(updated)?updated[0]:updated}
const created=await sb('ha_users',{method:'POST',body:JSON.stringify([{...row,created_at:new Date().toISOString()}])});return Array.isArray(created)?created[0]:created}
function trustedIp(req){
  const candidates=[];
  const forwarded=clean(req?.headers?.['x-forwarded-for']);
  if(forwarded)candidates.push(...forwarded.split(',').map(x=>x.trim()));
  candidates.push(clean(req?.headers?.['x-real-ip']),clean(req?.socket?.remoteAddress));
  for(let value of candidates){
    if(!value)continue;
    value=value.replace(/^::ffff:/,'').replace(/^\[|\]$/g,'');
    if(isIP(value))return value;
  }
  return'';
}
function loginLocation(req){
  return{
    country:clean(req?.headers?.['x-vercel-ip-country'])||null,
    region:clean(req?.headers?.['x-vercel-ip-country-region'])||null,
    city:clean(req?.headers?.['x-vercel-ip-city'])||null
  };
}
function lightweightFingerprint(req){
  const ua=clean(req?.headers?.['user-agent']);
  const language=clean(req?.headers?.['accept-language']).split(',')[0];
  const platform=clean(req?.headers?.['sec-ch-ua-platform']);
  if(!ua&&!language&&!platform)return null;
  return createHash('sha256').update([ua,platform,language].join('|').toLowerCase()).digest('hex');
}
async function recordLogin(haUser,req){
  if(!haUser?.id)return;
  const now=new Date().toISOString(),ip=trustedIp(req),userAgent=clean(req?.headers?.['user-agent']),location=loginLocation(req),fingerprint=lightweightFingerprint(req);
  const patch={last_login:now,last_seen_at:now,login_count:Number(haUser.login_count||0)+1,user_agent:userAgent,last_ip:ip,updated_at:now};
  try{await sb(`ha_users?id=eq.${encodeURIComponent(haUser.id)}`,{method:'PATCH',body:JSON.stringify(patch),prefer:'return=minimal'})}catch(e){console.warn('[auth] login summary update skipped:',e.message)}
  try{
    await sb('ha_login_events',{method:'POST',body:JSON.stringify([{user_id:haUser.id,organization_id:haUser.organization_id||null,email:lower(haUser.email),logged_in_at:now,ip_address:ip||null,user_agent:userAgent||null,device_fingerprint:fingerprint,country:location.country,region:location.region,city:location.city,created_at:now}]),prefer:'return=minimal'});
    const cutoff=new Date(Date.now()-90*86400000).toISOString();
    await sb(`ha_login_events?logged_in_at=lt.${encodeURIComponent(cutoff)}`,{method:'DELETE',prefer:'return=minimal'}).catch(e=>console.warn('[auth] login event cleanup skipped:',e.message));
  }catch(e){console.warn('[auth] login event insert skipped:',e.message)}
}
function publicUser(authUser,haUser){return{id:haUser?.id||'',auth_user_id:authUser?.id||haUser?.auth_user_id||'',email:haUser?.email||authUser?.email||'',name:haUser?.name||authUser?.user_metadata?.name||'',company:haUser?.company||'',organization_id:haUser?.organization_id||'',app_role:haUser?.app_role||'',status:haUser?.status||''}}
// Internal founder notifications (product-owner sprint). Identity for both
// notifications below always comes from haUser -- the verified Supabase
// auth user resolved server-side by ensureOrgAndUser()/recordLogin() above,
// never from raw req.body. Delivery is fully best-effort: any failure
// (missing RESEND_API_KEY, a Resend error, a network failure) is caught and
// logged here and never propagates to the caller, so a notification issue
// can never fail or delay the actual signup/login response.
function escapeHtml(v=''){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
const FOUNDER_NOTIFY_EMAIL='keegan@houseaccounts.ai';
async function sendFounderNotification(subject,html){const key=process.env.RESEND_API_KEY;if(!key)return;try{const from=process.env.RESEND_FROM_EMAIL||process.env.ALERTS_FROM_EMAIL||'House Accounts <hello@houseaccounts.ai>';const resp=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:FOUNDER_NOTIFY_EMAIL,subject,html})});if(!resp.ok){const data=await resp.json().catch(()=>({}));console.warn('[auth] founder notification failed:',resp.status,data.message||'')}}catch(e){console.warn('[auth] founder notification failed:',e.message)}}
function founderNotificationHtml(haUser,timestampLabel,timestampIso){return `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#17375E;"><p><strong>Name:</strong> ${escapeHtml(haUser?.name)||'—'}</p><p><strong>Email:</strong> ${escapeHtml(haUser?.email)||'—'}</p><p><strong>Organization/Company:</strong> ${escapeHtml(haUser?.company)||'—'}</p><p><strong>${escapeHtml(timestampLabel)}:</strong> ${escapeHtml(timestampIso)}</p></div>`}
async function notifyFounderOfSignup(haUser){await sendFounderNotification(`New House Accounts signup — ${haUser?.email||''}`,founderNotificationHtml(haUser,'Signup time',new Date().toISOString()))}
async function notifyFounderOfActivation(haUser){await sendFounderNotification(`House Accounts user activated — ${haUser?.email||''}`,founderNotificationHtml(haUser,'First login time',new Date().toISOString()))}
export default async function handler(req,res){try{const action=req.method==='GET'?(req.query?.action||'me'):(req.body?.action||'');
// Public Turnstile site key (not a secret -- Cloudflare's own sitekey is
// meant to be embedded client-side) served from an env var rather than
// hardcoded, so Preview/Production can point at different Turnstile
// widgets exactly like every other provider key in this codebase.
if(action==='turnstile-config'){return json(res,200,{ok:true,siteKey:process.env.TURNSTILE_SITE_KEY||''})}
if(action==='signup'){const email=lower(req.body.email),password=clean(req.body.password);if(!email||!password)return json(res,400,{error:'Email and password are required.'});
// Founder-directed bounded signup-abuse remediation (2026-08-25), after an
// observed automated public-signup spam pattern (a shortened URL injected
// into the Name field). Both checks below run BEFORE the Supabase Admin
// API call and any database write -- an invalid/unverified submission is
// rejected outright (400), never silently sanitized into a junk account.
const houseAccountsRaw=req.body.house_accounts||req.body.houseAccounts;
const profileCheck=validateSignupProfile({name:req.body.name,organizationName:req.body.organizationName,role:req.body.role,crm_erp:req.body.crm_erp||req.body.crmErp,house_accounts:houseAccountsRaw});
if(!profileCheck.valid)return json(res,400,{error:profileCheck.error});
// Fail closed: any non-success (missing/invalid token, missing secret, a
// Cloudflare/network error) rejects the signup. Only a generic message
// ever reaches the client -- never the raw provider reason/error codes.
const turnstile=await verifyTurnstileToken({token:req.body.turnstileToken,secret:process.env.TURNSTILE_SECRET_KEY,remoteIp:trustedIp(req)});
if(!turnstile.success)return json(res,400,{error:'We could not verify you are human. Please try again.'});
let authUser;try{authUser=await authFetch('admin/users',{method:'POST',body:JSON.stringify({email,password,email_confirm:true,user_metadata:{name:clean(req.body.name),organization_name:clean(req.body.organizationName),role:clean(req.body.role),house_accounts:clean(req.body.house_accounts||req.body.houseAccounts),crm_erp:clean(req.body.crm_erp||req.body.crmErp),plan:clean(req.body.plan)}})});}catch(err){if(String(err.message||'').toLowerCase().includes('already')){return json(res,409,{error:'An account already exists for this email. Please log in.'})}throw err}const haUser=await ensureOrgAndUser(authUser,{email,name:req.body.name,organizationName:req.body.organizationName,role:req.body.role,house_accounts:req.body.house_accounts||req.body.houseAccounts,crm_erp:req.body.crm_erp||req.body.crmErp,plan:req.body.plan});await notifyFounderOfSignup(haUser);const data=await authFetch('token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});await recordLogin(haUser,req);return json(res,200,{ok:true,session:{access_token:data.access_token,refresh_token:data.refresh_token,expires_in:data.expires_in,expires_at:Math.floor(Date.now()/1000)+Number(data.expires_in||3600),token_type:data.token_type},user:publicUser(data.user||authUser,haUser)})}
if(action==='login'){const email=lower(req.body.email),password=clean(req.body.password);if(!email||!password)return json(res,400,{error:'Email and password are required.'});const data=await authFetch('token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});const authUser=data.user;const haUser=await ensureOrgAndUser(authUser,{email});const isFirstLogin=!(haUser.login_count);await recordLogin(haUser,req);if(isFirstLogin)await notifyFounderOfActivation(haUser);return json(res,200,{ok:true,session:{access_token:data.access_token,refresh_token:data.refresh_token,expires_in:data.expires_in,expires_at:Math.floor(Date.now()/1000)+Number(data.expires_in||3600),token_type:data.token_type},user:publicUser(authUser,haUser)})}
if(action==='refresh'){const refresh_token=clean(req.body.refresh_token);if(!refresh_token)return json(res,400,{error:'Missing refresh token.'});const data=await authFetch('token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token})});const haUser=await ensureOrgAndUser(data.user,{email:data.user?.email});return json(res,200,{ok:true,session:{access_token:data.access_token,refresh_token:data.refresh_token||refresh_token,expires_in:data.expires_in,expires_at:Math.floor(Date.now()/1000)+Number(data.expires_in||3600),token_type:data.token_type},user:publicUser(data.user,haUser)})}
if(action==='recover'){const email=lower(req.body.email);if(!email)return json(res,400,{error:'Email is required.'});const redirectTo=`${appBaseUrl(req)}/update-password`;await authFetch(`recover?redirect_to=${encodeURIComponent(redirectTo)}`,{method:'POST',body:JSON.stringify({email})});return json(res,200,{ok:true})}
if(action==='update-password'){const auth=req.headers.authorization||'';const password=clean(req.body.password);if(!auth||!password)return json(res,400,{error:'Missing session or password.'});const data=await authFetch('user',{method:'PUT',headers:{Authorization:auth},body:JSON.stringify({password})});return json(res,200,{ok:true,user:data})}
if(action==='logout'){return json(res,200,{ok:true})}
if(action==='me'){const auth=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const authUser=await getAuthUser(auth);if(!authUser?.id)return json(res,401,{error:'Not authenticated'});const haUser=await ensureOrgAndUser(authUser,{email:authUser.email});return json(res,200,{ok:true,user:publicUser(authUser,haUser)})}
return json(res,400,{error:'Unknown auth action.'})}catch(err){return json(res,500,{error:err.message||'Auth failed'})}}
