(function(){
  const form=document.getElementById('signupForm');
  if(!form) return;
  const submit=document.getElementById('signupSubmit');
  const message=document.getElementById('signupMessage');
  const params=new URLSearchParams(location.search);
  const next=params.get('next')||'/dashboard/';

  // Founder-directed bounded signup-abuse remediation (2026-08-25), fixed
  // 2026-08-26 after Preview QA found the widget could permanently never
  // initialize. The widget id/token live in this closure; api/auth.js's
  // signup branch verifies the token server-side and fails closed if it's
  // missing or invalid, so this client-side piece only needs to: render
  // the widget once BOTH readiness conditions below are true, track the
  // current token, reset the widget after a failed submit, and give the
  // user a clear, DIFFERENT message for "still loading" vs. "failed to
  // load at all" -- never leave them stuck on "please wait" forever.
  //
  // Two independent async readiness signals, each of which can complete in
  // EITHER order relative to the other:
  //   1. The Cloudflare Turnstile script itself (window.__turnstileScriptReady
  //      -- set by the inline placeholder in signup.html, which exists
  //      before the async <script> tag can possibly call back into it; see
  //      that inline script's own comment for why this file must NOT be
  //      the thing that first defines window.onTurnstileLoad).
  //   2. Our own site-key fetch (fetchedSiteKey below).
  // tryRenderTurnstile() is idempotent and safe to call from either signal
  // the moment it completes -- it only actually renders once both are true.
  let turnstileToken='';
  let turnstileWidgetId=null;
  let turnstileRendered=false;
  let turnstileInitFailed=false;
  let fetchedSiteKey='';
  const turnstileContainer=document.getElementById('turnstileContainer');

  function tryRenderTurnstile(){
    if(turnstileRendered || turnstileInitFailed) return;
    if(!fetchedSiteKey || !turnstileContainer || !window.turnstile) return;
    turnstileRendered=true;
    turnstileWidgetId=window.turnstile.render(turnstileContainer,{
      sitekey:fetchedSiteKey,
      callback:token=>{turnstileToken=token||'';},
      'error-callback':()=>{turnstileToken='';},
      'expired-callback':()=>{turnstileToken='';}
    });
  }

  // The Cloudflare script may already have finished loading by the time
  // THIS file runs (e.g. a fast/cached response) -- in that case
  // __turnstileScriptReady is already true and no later callback will ever
  // fire, so check for that directly rather than only registering a
  // future hook.
  if(window.__turnstileScriptReady) tryRenderTurnstile();
  else window.__onTurnstileScriptReady=tryRenderTurnstile;

  fetch('/api/auth?action=turnstile-config').then(r=>r.json()).then(data=>{
    fetchedSiteKey=data && data.siteKey || '';
    if(!fetchedSiteKey){
      // The server responded, but this environment has no Turnstile site
      // key configured -- distinct from "still loading": this will never
      // resolve on its own, so say so now rather than waiting out the
      // timeout below.
      turnstileInitFailed=true;
      show('Verification is not available right now. Please contact support.');
      return;
    }
    tryRenderTurnstile();
  }).catch(()=>{
    turnstileInitFailed=true;
    show('We could not load verification. Please refresh the page and try again.');
  });

  // Load-failure timeout: if Turnstile genuinely never becomes ready (the
  // Cloudflare script blocked/failed to load, a slow/broken network, etc.)
  // the two signals above simply never fire and the user would otherwise
  // be stuck on "please wait a moment" indefinitely. 12 seconds is
  // comfortably longer than a normal load (both signals are typically
  // sub-second) without leaving a genuinely broken page looking like it's
  // still working. Overridable via window.__turnstileInitTimeoutMs so the
  // deterministic browser test can exercise this path in well under a
  // second instead of actually waiting 12 real seconds -- production
  // behavior is unaffected since nothing ever sets that global.
  setTimeout(()=>{
    if(turnstileRendered || turnstileInitFailed) return;
    turnstileInitFailed=true;
    show('We could not load verification. Please refresh the page and try again.');
  }, window.__turnstileInitTimeoutMs || 12000);
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
    if(!turnstileToken){
      show(turnstileInitFailed ? 'We could not load verification. Please refresh the page and try again.' : 'Please wait a moment for verification to finish loading, then try again.');
      return;
    }
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
