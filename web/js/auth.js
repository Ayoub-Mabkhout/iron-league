// Name and password sign-in. The password stays on this device: it derives an auth secret (PBKDF2 then HKDF, in
// private-vault.js) and only that secret is sent. After signing in, the private vault is unlocked in memory for this tab.
import {el,icon,button,toast,card,row} from './core.js';
import {api,ApiError} from './api.js';
import * as vault from './private-vault.js';

let available=null,unlocked=null,emailRecovery=false;
/** Whether this server has password sign-in switched on; it answers 404 while the feature is off. It also says whether
 * it can send password-reset emails; until then the email field stays hidden. */
export async function enabled(){
  if(available!==null)return available;
  try{const p=await api('auth/parameters?name=probe');available=true;emailRecovery=p?.email_recovery===true}catch(e){available=e instanceof ApiError&&e.status!==404}
  return available;
}
export const emailEnabled=()=>emailRecovery;
/** Why we ask, in one place so the sign-up form and Profile say the same thing. */
export const EMAIL_WHY='Optional. Used only to send you a link to reset your password if you forget it, as an alternative to the recovery key. It is never shown to friends. A reset by email gets you back into your profile and workouts; private records stay encrypted and still need your recovery key.';
const validEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
export async function saveEmail(email){return api('auth/email',{method:'PUT',body:{email:email||null}})}
export const vaultHandle=()=>unlocked;

const message=(e,fallback)=>!(e instanceof ApiError)?'No connection. Try again when you are online.':e.status===429?'Too many tries. Wait a few minutes, then try again.':e.status===401?'Name or password is incorrect.':e.message||fallback;

export async function signIn(name,password){
  const params=await api('auth/parameters?name='+encodeURIComponent(name));
  const account=await api('auth/login',{body:{name,auth_secret:await vault.deriveAuthSecret(password,params)}});
  await unlock(password);return account;
}
/** A new profile, or a password for the profile this browser already holds (claim). Returns the recovery key once. */
export async function enrollPassword(name,password,{claim=false}={}){
  const params=vault.passwordParameters();
  const account=await api(claim?'auth/claim':'auth/register',{body:{name,auth_secret:await vault.deriveAuthSecret(password,params),client_salt:params.salt}});
  const made=await vault.enroll(password,account.id,params);
  try{await api('vault/key-envelope',{method:'PUT',body:{base_revision:0,record:made.record}});unlocked=made.vault}
  catch{vault.destroy(made.vault);return {account,recoveryKey:null}}
  return {account,recoveryKey:made.recoveryKey};
}
async function unlock(password){
  try{const {record}=await api('vault/key-envelope');if(unlocked)vault.destroy(unlocked);unlocked=(await vault.unlock(password,record)).vault}catch{unlocked=null}
  return !!unlocked;
}
/** Asks for the password to open private records in this tab (after a reload only the session cookie remains).
 * Resolves true once unlocked. The password stays on this device. */
export function unlockDialog(){
  if(unlocked)return Promise.resolve(true);
  return new Promise(resolve=>{
    const d=el('dialog',{class:'dialog'}),note=el('p',{class:'dialog-text',text:'Your photos are encrypted on this device. Enter your password to open them.',attrs:{role:'status'}});
    const pass=el('input',{class:'field',type:'password',autocomplete:'current-password',placeholder:'Password',attrs:{'aria-label':'Password'}});
    let result=false;const finish=v=>{result=v;d.close()};
    const go=el('button',{class:'btn primary',type:'submit',text:'Unlock'});
    const form=el('form',{},el('h3',{text:'Unlock your photos'}),note,pass,el('div',{class:'dialog-actions'},button('Cancel','btn ghost',()=>finish(false)),go));
    form.onsubmit=async e=>{e.preventDefault();if(!pass.value){pass.focus();return}go.disabled=true;note.textContent='Unlocking…';
      if(await unlock(pass.value)){pass.value='';finish(true)}else{go.disabled=false;note.textContent='That password did not open your photos. Try again.';pass.select()}};
    d.addEventListener('close',()=>{d.remove();resolve(result)});d.append(form);document.body.append(d);d.showModal();setTimeout(()=>pass.focus(),40);
  });
}
export async function signOut(){
  if(unlocked){vault.destroy(unlocked);unlocked=null}
  try{await api('auth/logout',{method:'POST',body:{}})}catch{}
  try{localStorage.removeItem('train-account')}catch{}
  location.replace(location.pathname);
}

/** The sign-in screen: sign in, or create a profile with a new name. With `claim`, the profile this browser joined by link
 * sets its password (the server asks for one before anything else works). */
export function screen(root,done,claim=null){
  let mode=claim?'claim':'signin';
  const name=el('input',{class:'field',autocomplete:'username',maxLength:80,placeholder:'Name',attrs:{'aria-label':'Name',autocapitalize:'words'}});
  const pass=el('input',{class:'field',type:'password',autocomplete:'current-password',placeholder:'Password',attrs:{'aria-label':'Password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const go=el('button',{class:'btn primary wide',type:'submit'}),note=el('p',{class:'hint',attrs:{role:'status'}});
  const email=el('input',{class:'field',type:'email',autocomplete:'email',placeholder:'Email for password reset (optional)',attrs:{'aria-label':'Email for password reset, optional','aria-describedby':'email-why'}});
  const why=el('p',{class:'hint small',text:EMAIL_WHY,attrs:{id:'email-why'}}),mailBox=el('div',{class:'auth-email'},email,why);
  const forgot=el('button',{type:'button',class:'link-btn',text:'Forgot password?'});forgot.onclick=()=>forgotPassword(name.value.trim());
  const tabs=el('div',{class:'segmented',attrs:{role:'tablist'}}),form=el('form',{class:'auth-form'},name,pass,again,mailBox,go,note,forgot);
  const show=m=>{mode=m;note.textContent='';again.hidden=m==='signin';mailBox.hidden=m==='signin'||!emailRecovery;forgot.hidden=m!=='signin'||!emailRecovery;pass.autocomplete=m==='signin'?'current-password':'new-password';go.textContent={signin:'Sign in',create:'Create profile',claim:'Set password'}[m];
    if(m==='claim'){tabs.hidden=true;return}
    tabs.replaceChildren(...[['signin','Sign in'],['create','New profile']].map(([k,t])=>{const b=el('button',{type:'button',class:'seg'+(k===m?' on':''),text:t,attrs:{role:'tab','aria-selected':String(k===m)}});b.onclick=()=>show(k);return b}))};
  form.onsubmit=async e=>{e.preventDefault();const n=name.value.trim(),p=pass.value,mail=email.value.trim();
    if(!n){name.focus();return}if(!p){pass.focus();return}
    if(mode!=='signin'&&mail&&!validEmail(mail)){note.textContent='Check the email address, or leave it empty.';email.focus();return}
    if(mode!=='signin'){if(p.length<10){note.textContent='Use at least 10 characters.';pass.focus();return}if(p!==again.value){note.textContent="The passwords don't match.";again.focus();return}}
    go.disabled=true;note.textContent={signin:'Signing in…',create:'Creating your profile…',claim:'Setting your password…'}[mode];
    try{if(mode==='signin')done(await signIn(n,p));else{const r=await enrollPassword(n,p,{claim:mode==='claim'});let withEmail=false;
      if(mail&&emailRecovery)try{await saveEmail(mail);withEmail=true}catch{toast("Couldn't save the email. Add it later in Profile.")}
      recoveryKey(r.recoveryKey,()=>done(r.account),withEmail)}}
    catch(err){go.disabled=false;note.textContent=mode!=='signin'&&err instanceof ApiError&&err.status===409?(mode==='claim'?'Enter the name this profile uses, exactly as shown in Friends.':'That name is taken. Sign in, or choose another name.'):message(err,'Your server refused the request.')}};
  if(claim?.name)name.value=claim.name;show(mode);
  root.replaceChildren(el('main',{class:'join'},el('span',{class:'mark'},icon('barbell')),el('h1',{text:claim?'Set a password':'Iron League'}),
    el('p',{class:'hint',text:claim?'Iron League now signs in with your name and a password. Your workouts stay with this profile, and the password never leaves this device.':'Your password never leaves this device.'}),tabs,form));
  setTimeout(()=>(claim?.name?pass:name).focus(),60);
}

/** Shown once after a password is set: the only copy of the key that can reopen private records without the password. */
export function recoveryKey(key,next,withEmail=false){
  if(!key){next();return}
  const d=el('dialog',{class:'dialog recovery'});const code=el('code',{class:'recovery-key',text:key.match(/.{1,4}/g).join(' ')});
  const copy=button('Copy','btn',async()=>{try{await navigator.clipboard.writeText(key);toast('Recovery key copied')}catch{toast('Select the key and copy it')}});
  const ok=button("I've saved it",'btn primary wide',()=>{d.close();d.remove();next()});
  d.append(el('h3',{text:'Save your recovery key'}),el('p',{class:'dialog-text',text:withEmail?'Your email can reset your password. Your private records are encrypted with a key only you hold, so after a reset they open only with this recovery key. Keep it somewhere safe; Iron League cannot show it again.':'Keep it somewhere safe, like a password manager. It is the only way to open your private records if you forget your password, and Iron League cannot show it again.'}),code,copy,ok);
  d.addEventListener('cancel',e=>e.preventDefault());document.body.append(d);d.showModal();
}

/** Asks the server to email a reset link. The answer is the same whether or not the name has an email, so it can't be
 * used to learn who registered one. */
function forgotPassword(prefill){
  const d=el('dialog',{class:'dialog'}),name=el('input',{class:'field',value:prefill,placeholder:'Name',attrs:{'aria-label':'Name'}}),note=el('p',{class:'dialog-text',text:'We will email a reset link to the address saved on this profile.'});
  const send=button('Send link','btn primary',async()=>{const n=name.value.trim();if(!n){name.focus();return}send.disabled=true;
    try{await api('auth/recovery/email',{body:{name:n}});note.textContent='If that profile has a recovery email, a link is on its way. It works once and expires soon.';send.hidden=true}
    catch(e){note.textContent=message(e,"Couldn't send the link.");send.disabled=false}});
  d.append(el('h3',{text:'Reset your password'}),note,name,el('div',{class:'dialog-actions'},button('Close','btn ghost',()=>{d.close();d.remove()}),send));
  document.body.append(d);d.showModal();
}

/** The page a reset link opens: a new password, and the recovery key if they have it, to reopen private records too. */
export function resetScreen(root,token,done){
  const pass=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'New password',attrs:{'aria-label':'New password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const key=el('input',{class:'field',autocomplete:'off',placeholder:'Recovery key (optional)',attrs:{'aria-label':'Recovery key, optional',spellcheck:'false'}});
  const go=el('button',{class:'btn primary wide',type:'submit',text:'Set new password'}),note=el('p',{class:'hint',attrs:{role:'status'}});
  const form=el('form',{class:'auth-form'},pass,again,key,el('p',{class:'hint small',text:'Without the recovery key you get your profile and workouts back, but private records stay locked.'}),go,note);
  form.onsubmit=async e=>{e.preventDefault();const p=pass.value,k=key.value.replace(/\s+/g,'');
    if(p.length<10){note.textContent='Use at least 10 characters.';return}if(p!==again.value){note.textContent="The passwords don't match.";return}
    go.disabled=true;note.textContent='Setting your password…';const params=vault.passwordParameters();
    try{const account=await api('auth/recovery/email/complete',{body:{token,auth_secret:await vault.deriveAuthSecret(p,params),client_salt:params.salt}});
      if(k)try{const {record,revision}=await api('vault/key-envelope');const r=await vault.recover(k,record,p,params);await api('vault/key-envelope',{method:'PUT',body:{base_revision:revision,record:r.record}});unlocked=r.vault}
        catch{toast("Password reset. That recovery key didn't open your private records.")}
      done(account)}
    catch(err){go.disabled=false;note.textContent=err instanceof ApiError&&(err.status===404||err.status===410)?'This link has expired or was already used. Ask for a new one.':message(err,"Couldn't reset the password.")}};
  root.replaceChildren(el('main',{class:'join'},el('span',{class:'mark'},icon('barbell')),el('h1',{text:'New password'}),el('p',{class:'hint',text:'Choose a new password for your profile.'}),form));
  setTimeout(()=>pass.focus(),60);
}

/** Profile card: set a password for a profile joined by link, the optional recovery email, or sign out. */
export async function accountCard(me){
  if(!await enabled())return null;
  const c=card(el('h3',{class:'card-title',text:'Sign-in'}));
  const pass=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'New password',attrs:{'aria-label':'New password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const save=button('Set password','btn primary wide',async()=>{const p=pass.value;if(p.length<10){toast('Use at least 10 characters');return}if(p!==again.value){toast("The passwords don't match");return}
    save.disabled=true;try{const r=await enrollPassword(me.name,p,{claim:true});pass.value=again.value='';recoveryKey(r.recoveryKey,()=>toast('Password set. Sign in with '+me.name+' on any device.'));
      if(unlocked)import('./photos.js').then(m=>m.migrate()).catch(()=>{})}
    catch(e){toast(e instanceof ApiError&&e.status===409?'This profile already has a password.':message(e,"Couldn't set the password."))}finally{save.disabled=false}});
  c.append(el('p',{class:'hint',text:'Set a password to sign in as '+me.name+' on another device without a link.'}),pass,again,save);
  if(emailRecovery){let current=null;try{current=await api('auth/email')}catch{}
    const mail=el('input',{class:'field',type:'email',autocomplete:'email',value:current?.email||'',placeholder:'Recovery email (optional)',attrs:{'aria-label':'Recovery email, optional'}});
    const status=el('small',{class:'hint',text:current?.email?(current.verified?'Confirmed.':'Check your inbox to confirm this address.'):''});
    const keep=button('Save email','btn',async()=>{const v=mail.value.trim();if(v&&!validEmail(v)){toast('Check the email address');return}
      try{const r=await saveEmail(v);status.textContent=v?(r?.verified?'Confirmed.':'Check your inbox to confirm this address.'):'';toast(v?'Recovery email saved':'Recovery email removed')}catch(e){toast(message(e,"Couldn't save the email."))}});
    c.append(el('p',{class:'label',text:'Recovery email'}),el('p',{class:'hint small',text:EMAIL_WHY}),mail,status,keep)}
  c.append(row('Sign out','Set a password first, or you will need a new link to get back in',()=>signOut()));
  return c;
}
