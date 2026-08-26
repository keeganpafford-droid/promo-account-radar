(function(){
  const form=document.getElementById('signupForm');
  if(!form) return;
  const submit=document.getElementById('signupSubmit');
  const message=document.getElementById('signupMessage');
  const params=new URLSearchParams(location.search);
  const next=params.get('next')||'/dashboard/';

  // Founder-directed bounded signup-abuse remediation (2026-08-25):
  // Cloudflare Turnstile, explicit render. The widget id/token live in this
  // closure; api/auth.js's signup branch verifies the token server-side and
  // fails closed if it's missing or invalid, so this client-side piece only
  // needs to: render the widget once both the API script and the site key
  // are ready, track the current token, reset the widget (issuing a fresh
  // token) after a failed submit, and give a clear message when the widget
  // itself hasn't loaded/finished yet -- never silently submit without it.
  let turnstileToken='';
  let turnstileWidgetId=null;
  let turnstileReady=false;
  const turnstileContainer=document.getElementById('turnstileContainer');
  function renderTurnstileIfReady(siteKey){
    if(turnstileReady || !siteKey || !turnstileContainer || !window.turnstile) return;
    turnstileReady=true;
    turnstileWidgetId=window.turnstile.render(turnstileContainer,{
      sitekey:siteKey,
      callback:token=>{turnstileToken=token||'';},
      'error-callback':()=>{turnstileToken='';},
      'expired-callback':()=>{turnstileToken='';}
    });
  }
  let fetchedSiteKey='';
  window.onTurnstileLoad=function(){ renderTurnstileIfReady(fetchedSiteKey); };
  fetch('/api/auth?action=turnstile-config').then(r=>r.json()).then(data=>{
    fetchedSiteKey=data && data.siteKey || '';
    renderTurnstileIfReady(fetchedSiteKey);
  }).catch(()=>{ /* verification is still enforced server-side; the form's own submit error will explain a failure */ });
  // 2026-08-13 pricing decision: no new 30-day paid-capacity trials are
  // granted -- see api/auth.js's orgDefaults(), which already records a
  // requested 'solo'/'team' plan value harmlessly but grants no trial
  // dates/status regardless. requestedPlan is kept (still sent to signup
  // for that same harmless historical recording) but no longer changes
  // this page's own copy/CTA -- the retired "?plan=solo"/"?plan=team"
  // signup-time trial offer this branch used to render ("Start 30-Day Free
  // Trial") promised something the backend has not granted for months; the
  // markup's own default Free-forever copy is accurate for every visitor
  // now, regardless of which plan query param they arrived with.
  const requestedPlan=['solo','team'].includes((params.get('plan')||'').toLowerCase())?(params.get('plan')||'').toLowerCase():'free';

  function value(name){
    const field=form.elements.namedItem(name);
    return field && typeof field.value==='string' ? field.value.trim() : '';
  }
  function setError(name,text){
    const field=form.elements.namedItem(name);
    const wrapper=field?.closest('.auth-field');
    if(!wrapper) return;
    wrapper.classList.toggle('has-error',Boolean(text));
    const target=wrapper.querySelector('.auth-error');
    if(target) target.textContent=text||'';
  }
  function clearErrors(){
    form.querySelectorAll('.auth-field').forEach(el=>el.classList.remove('has-error'));
    form.querySelectorAll('.auth-error').forEach(el=>el.textContent='');
    message.className='auth-message'; message.textContent='';
  }
  function show(text,type='error'){
    message.textContent=text;
    message.className='auth-message '+type;
  }
  function validate(){
    clearErrors();
    let valid=true;
    const required={name:'Enter your name.',organizationName:'Enter your company or organization.',role:'Choose your role.',email:'Enter your work email.',password:'Enter a password.'};
    Object.entries(required).forEach(([name,text])=>{if(!value(name)){setError(name,text);valid=false;}});
    const email=value('email');
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setError('email','Enter a valid email address.');valid=false;}
    const count=Number(value('house_accounts'));
    if(!value('house_accounts') || !Number.isFinite(count) || count<=0){setError('house_accounts','Enter a number greater than zero.');valid=false;}
    return valid;
  }

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!validate()) return;
    // The server independently verifies (and fails closed on) the
    // Turnstile token regardless of this check -- this is purely a faster,
    // friendlier message for the one case where the widget genuinely
    // hasn't finished loading yet, instead of a round trip to the server
    // just to learn the same thing.
    if(!turnstileToken){ show('Please wait a moment for verification to finish loading, then try again.'); return; }
    submit.disabled=true;
    submit.textContent='Creating account…';
    try{
      await HouseAuth.api('signup',{
        name:value('name'),
        organizationName:value('organizationName'),
        role:value('role'),
        house_accounts:value('house_accounts'),
        crm_erp:value('crm_erp'),
        email:value('email').toLowerCase(),
        password:value('password'),
        plan:requestedPlan,
        turnstileToken
      });
      location.href=next;
    }catch(error){
      show(error.message||'We could not create your account. Please try again.');
      // A Turnstile token is single-use -- whether this particular failure
      // was the verification itself or something else entirely (e.g. a
      // duplicate email), the already-spent token can't be reused on a
      // retry, so always issue a fresh one.
      if(turnstileWidgetId!=null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
      turnstileToken='';
    }finally{
      submit.disabled=false;
      submit.textContent='Start Free';
    }
  });
})();
