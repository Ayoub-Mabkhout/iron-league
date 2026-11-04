// Name and password sign-in. The password stays on this device: it derives an auth secret (PBKDF2 then HKDF, in
// private-vault.js) and only that secret is sent. After signing in, the private vault is unlocked in memory for this tab.
// A passkey can do the same without the password (passkeys.js), and so resets a forgotten password without a code.
import {el,icon,button,toast,card,row,choiceDialog} from './core.js';
import {api,ApiError} from './api.js';
import * as vault from './private-vault.js';
import * as passkeys from './passkeys.js';

let available=null,unlocked=null,emailRecovery=false;
// After a passkey sign-in or unlock in this tab: its ID and server secret, so a new password can be set without the old
// one. Memory only, like the unlocked vault; cleared on sign-out.
let proof=null;
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
export async function enrollPassword(name,password,{claim=false,invite=null}={}){
  const params=vault.passwordParameters();
  const body={name,auth_secret:await vault.deriveAuthSecret(password,params),client_salt:params.salt};if(!claim)body.invite=invite;
  const account=await api(claim?'auth/claim':'auth/register',{body});
  const made=await vault.enroll(password,account.id,params);
  try{await api('vault/key-envelope',{method:'PUT',body:{base_revision:0,record:made.record}});unlocked=made.vault}
  catch{vault.destroy(made.vault);return {account,recoveryKey:null}}
  return {account,recoveryKey:made.recoveryKey};
}
async function unlock(password){
  try{const {record}=await api('vault/key-envelope');if(unlocked)vault.destroy(unlocked);unlocked=(await vault.unlock(password,record)).vault}catch{unlocked=null}
  return !!unlocked;
}
const passkeyMessage=(e,fallback)=>e instanceof passkeys.PasskeyError?(e.code==='cancelled'?'':e.message):e instanceof ApiError&&e.status===401?"This passkey isn't set up for Iron League. Sign in with your password, then add it in Profile.":message(e,fallback);
/** Opens the vault with a passkey that has a copy of its key. Ids limit the prompt to those passkeys. */
async function unlockWithPasskey(record,credentialId,prf){
  try{const r=await vault.unlockWithPasskey(record,credentialId,prf);if(unlocked)vault.destroy(unlocked);unlocked=r.vault;proof={credentialId,authSecret:r.authSecret};return true}
  catch{return false}
}
/** Discoverable passkey sign-in: the browser lists this site's passkeys, then the vault opens with the same passkey. */
export async function signInWithPasskey(){
  const {credentialId,prf}=await passkeys.get();
  try{const authSecret=await vault.derivePasskeyAuthSecret(prf);
    const account=await api('auth/passkey/login',{body:{credential_id:credentialId,auth_secret:authSecret}});
    proof={credentialId,authSecret};
    try{const {record}=await api('vault/key-envelope');await unlockWithPasskey(record,credentialId,prf)}catch{}
    return account;
  }finally{prf.fill(0)}
}
export const canSetNewPassword=()=>!!proof;
/** Asks for the password to open private records in this tab (after a reload only the session cookie remains).
 * Resolves true once unlocked. The password stays on this device. */
export function unlockDialog(){
  if(unlocked)return Promise.resolve(true);
  return new Promise(resolve=>{
    const d=el('dialog',{class:'dialog'}),note=el('p',{class:'dialog-text',text:'Your photos are encrypted on this device. Enter your password to open them.',attrs:{role:'status'}});
    const pass=el('input',{class:'field',type:'password',autocomplete:'current-password',placeholder:'Password',attrs:{'aria-label':'Password'}});
    let result=false;const finish=v=>{result=v;d.close()};
    const go=el('button',{class:'btn primary',type:'submit',text:'Unlock'});
    const key=button('Use a passkey','btn wide',async()=>{key.disabled=true;note.textContent='Waiting for your passkey…';
      try{const {record}=await api('vault/key-envelope'),ids=vault.passkeyIds(record);
        if(!ids.length){note.textContent='No passkey can open your photos yet. Enter your password, then add a passkey in Profile.';return}
        const {credentialId,prf}=await passkeys.get(ids);
        try{if(await unlockWithPasskey(record,credentialId,prf)){pass.value='';finish(true)}else note.textContent='That passkey did not open your photos. Try your password.'}finally{prf.fill(0)}}
      catch(e){note.textContent=passkeyMessage(e,"Couldn't use the passkey.")||'Enter your password, or try the passkey again.'}
      finally{key.disabled=false}});
    const form=el('form',{},el('h3',{text:'Unlock your photos'}),note,pass,passkeys.available()?key:null,el('div',{class:'dialog-actions'},button('Cancel','btn ghost',()=>finish(false)),go));
    form.onsubmit=async e=>{e.preventDefault();if(!pass.value){pass.focus();return}go.disabled=true;note.textContent='Unlocking…';
      if(await unlock(pass.value)){pass.value='';finish(true)}else{go.disabled=false;note.textContent='That password did not open your photos. Try again.';pass.select()}};
    d.addEventListener('close',()=>{d.remove();resolve(result)});d.append(form);document.body.append(d);d.showModal();setTimeout(()=>pass.focus(),40);
  });
}
export async function signOut(){
  if(unlocked){vault.destroy(unlocked);unlocked=null}proof=null;
  try{await api('auth/logout',{method:'POST',body:{}})}catch{}
  try{localStorage.removeItem('train-account')}catch{}
  location.replace(location.pathname);
}

/** The sign-in screen: sign in, or create a profile with a new name. With `claim`, the profile this browser joined by link
 * sets its password (the server asks for one before anything else works). */
/** New profiles need an invite link from a member: it creates a profile, or sets the first password of the profile it was made for. */
export function screen(root,done,claim=null,invite=null){
  let mode=claim?'claim':invite?'create':'signin';
  const name=el('input',{class:'field',autocomplete:'username',maxLength:80,placeholder:'Name',attrs:{'aria-label':'Name',autocapitalize:'words'}});
  const pass=el('input',{class:'field',type:'password',autocomplete:'current-password',placeholder:'Password',attrs:{'aria-label':'Password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const go=el('button',{class:'btn primary wide',type:'submit'}),note=el('p',{class:'hint',attrs:{role:'status'}});
  const email=el('input',{class:'field',type:'email',autocomplete:'email',placeholder:'Email for password reset (optional)',attrs:{'aria-label':'Email for password reset, optional','aria-describedby':'email-why'}});
  const why=el('p',{class:'hint small',text:EMAIL_WHY,attrs:{id:'email-why'}}),mailBox=el('div',{class:'auth-email'},email,why);
  const forgot=el('button',{type:'button',class:'link-btn',text:'Forgot password?'});forgot.onclick=()=>forgotPassword(name.value.trim(),done);
  const withKey=button('Sign in with a passkey','btn wide',async()=>{withKey.disabled=true;note.textContent='Waiting for your passkey…';
    try{done(await signInWithPasskey())}catch(err){withKey.disabled=false;note.textContent=passkeyMessage(err,"Couldn't sign in with the passkey.")}});
  const canPasskey=passkeys.available();
  const noInvite=el('p',{class:'hint',text:'To create a profile, open the invite link a member sent you. If you already have a profile, sign in with its name.'});
  const tabs=el('div',{class:'segmented',attrs:{role:'tablist'}}),form=el('form',{class:'auth-form'},name,pass,again,mailBox,go,withKey,note,forgot);
  const show=m=>{mode=m;note.textContent='';again.hidden=m==='signin';mailBox.hidden=m==='signin'||!emailRecovery;forgot.hidden=m!=='signin'||!(emailRecovery||canPasskey);withKey.hidden=m!=='signin'||!canPasskey;pass.autocomplete=m==='signin'?'current-password':'new-password';go.textContent={signin:'Sign in',create:'Create profile',claim:'Set password'}[m];
    const blocked=m==='create'&&!invite;form.hidden=blocked;noInvite.hidden=!blocked;
    if(m==='claim'){tabs.hidden=true;return}
    tabs.replaceChildren(...[['signin','Sign in'],['create','New profile']].map(([k,t])=>{const b=el('button',{type:'button',class:'seg'+(k===m?' on':''),text:t,attrs:{role:'tab','aria-selected':String(k===m)}});b.onclick=()=>show(k);return b}))};
  form.onsubmit=async e=>{e.preventDefault();const n=name.value.trim(),p=pass.value,mail=email.value.trim();
    if(!n){name.focus();return}if(!p){pass.focus();return}
    if(mode!=='signin'&&mail&&!validEmail(mail)){note.textContent='Check the email address, or leave it empty.';email.focus();return}
    if(mode!=='signin'){if(p.length<10){note.textContent='Use at least 10 characters.';pass.focus();return}if(p!==again.value){note.textContent="The passwords don't match.";again.focus();return}}
    go.disabled=true;note.textContent={signin:'Signing in…',create:'Creating your profile…',claim:'Setting your password…'}[mode];
    try{if(mode==='signin')done(await signIn(n,p));else{const r=await enrollPassword(n,p,{claim:mode==='claim',invite});let withEmail=false;
      if(mail&&emailRecovery)try{await saveEmail(mail);withEmail=true}catch{toast("Couldn't save the email. Add it later in Profile.")}
      recoveryKey(r.recoveryKey,()=>done(r.account),withEmail)}}
    catch(err){go.disabled=false;note.textContent=mode!=='signin'&&err instanceof ApiError&&err.status===409?(mode==='claim'?'Enter the name this profile uses, exactly as shown in Friends.':invite?'That name is taken, or this link was made for a different profile. Check the name, or sign in.':'That name is taken. Sign in, or choose another name.'):message(err,'Your server refused the request.')}};
  if(claim?.name)name.value=claim.name;show(mode);
  root.replaceChildren(el('main',{class:'join'},el('span',{class:'mark'},icon('barbell')),el('h1',{text:claim?'Set a password':'Iron League'}),
    el('p',{class:'hint',text:claim?'Iron League now signs in with your name and a password. Your workouts stay with this profile, and the password never leaves this device.':invite?'Choose your name and a password. If this link was made for your existing profile, use that profile\u2019s name. Your password never leaves this device.':'Your password never leaves this device.'}),tabs,noInvite,form));
  setTimeout(()=>(claim?.name?pass:name).focus(),60);
}

/** Shown once after a password is set: the only copy of the key that can reopen private records without the password. */
export function recoveryKey(key,next,withEmail=false){
  if(!key){next();return}
  const d=el('dialog',{class:'dialog recovery'});const code=el('code',{class:'recovery-key',text:key.match(/.{1,4}/g).join(' ')});
  const copy=button('Copy','btn',async()=>{try{await navigator.clipboard.writeText(key);toast('Recovery key copied')}catch{toast('Select the key and copy it')}});
  const ok=button("I've saved it",'btn primary wide',()=>{d.close();d.remove();next()});
  const easier=passkeys.available()?el('p',{class:'hint small',text:'A passkey is the easier way back in: add one in Profile and it signs you in, opens your photos and lets you choose a new password. Keep this key as a fallback for when no passkey device is at hand.'}):null;
  d.append(el('h3',{text:'Save your recovery key'}),el('p',{class:'dialog-text',text:withEmail?'Your email can reset your password. Your private records are encrypted with a key only you hold, so after a reset they open only with this recovery key or a passkey. Keep it somewhere safe; Iron League cannot show it again.':'Keep it somewhere safe, like a password manager. Without a passkey, it is the only way to open your private records if you forget your password, and Iron League cannot show it again.'}),easier,code,copy,ok);
  d.addEventListener('cancel',e=>e.preventDefault());document.body.append(d);d.showModal();
}

/** A forgotten password: sign in with a passkey and choose a new one, or (where the server sends email) ask for a link.
 * The email answer is the same whether or not the name has an email, so it can't be used to learn who registered one. */
function forgotPassword(prefill,done){
  const d=el('dialog',{class:'dialog'}),close=()=>{d.close();d.remove()},parts=[el('h3',{text:'Reset your password'})];
  if(passkeys.available()){
    const status=el('p',{class:'hint small',attrs:{role:'status'}});
    const go=button('Sign in with a passkey','btn primary wide',async()=>{go.disabled=true;status.textContent='Waiting for your passkey…';
      try{const account=await signInWithPasskey();close();done(account);newPasswordDialog()}
      catch(e){go.disabled=false;status.textContent=passkeyMessage(e,"Couldn't sign in with the passkey.")}});
    parts.push(el('p',{class:'dialog-text',text:'Sign in with your passkey, then choose a new password. Your photos stay readable.'}),go,status);
  }
  let send=null;
  if(emailRecovery){
    const name=el('input',{class:'field',value:prefill,placeholder:'Name',attrs:{'aria-label':'Name'}}),note=el('p',{class:'dialog-text',text:'Or we will email a reset link to the address saved on this profile.'});
    send=button('Send link','btn primary',async()=>{const n=name.value.trim();if(!n){name.focus();return}send.disabled=true;
      try{await api('auth/recovery/email',{body:{name:n}});note.textContent='If that profile has a recovery email, a link is on its way. It works once and expires soon.';send.hidden=true}
      catch(e){note.textContent=message(e,"Couldn't send the link.");send.disabled=false}});
    parts.push(note,name);
  }
  if(parts.length===1)parts.push(el('p',{class:'dialog-text',text:'Use your recovery key from the device where you set your password, or ask a member for a new invite link.'}));
  d.append(...parts,el('div',{class:'dialog-actions'},button('Close','btn ghost',close),send));
  document.body.append(d);d.showModal();
}

/** After a passkey sign-in or unlock: a new password without the old one. The vault is re-wrapped for it (passkeys kept),
 * the server replaces the password and signs out other sessions, then the re-wrapped vault record is saved. */
export function newPasswordDialog(){
  if(!proof){toast('Sign in with a passkey first.');return}
  const d=el('dialog',{class:'dialog'}),note=el('p',{class:'dialog-text',text:'Your passkey confirmed it is you. Choose a new password; other devices will be signed out.',attrs:{role:'status'}});
  const pass=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'New password',attrs:{'aria-label':'New password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const go=el('button',{class:'btn primary',type:'submit',text:'Set new password'});
  const form=el('form',{},el('h3',{text:'Set a new password'}),note,pass,again,el('div',{class:'dialog-actions'},button('Cancel','btn ghost',()=>d.close()),go));
  form.onsubmit=async e=>{e.preventDefault();const p=pass.value;
    if(p.length<10){note.textContent='Use at least 10 characters.';pass.focus();return}if(p!==again.value){note.textContent="The passwords don't match.";again.focus();return}
    go.disabled=true;note.textContent='Setting your password…';
    try{await setNewPassword(p);pass.value=again.value='';d.close();toast('New password set. Other devices are signed out.')}
    catch(err){go.disabled=false;note.textContent=err?.partial||message(err,"Couldn't set the password.")}};
  d.addEventListener('close',()=>d.remove());d.append(form);document.body.append(d);d.showModal();setTimeout(()=>pass.focus(),40);
}
async function setNewPassword(password){
  const params=vault.passwordParameters();let envelope=null;
  try{envelope=await api('vault/key-envelope')}catch(e){if(!(e instanceof ApiError&&e.status===404))throw e}
  // With a vault, the new wrapper must be ready before the server switches passwords; it needs the unlocked key.
  if(envelope&&!unlocked)throw Object.assign(new Error('locked'),{partial:'Unlock your photos with the passkey first, then try again.'});
  const changed=envelope?await vault.changePassword(unlocked,envelope.record,password,params):{authSecret:await vault.deriveAuthSecret(password,params)};
  await api('auth/passkey/reset-password',{body:{credential_id:proof.credentialId,passkey_auth_secret:proof.authSecret,auth_secret:changed.authSecret,client_salt:params.salt}});
  if(!envelope)return;
  try{await api('vault/key-envelope',{method:'PUT',body:{base_revision:envelope.revision,record:changed.record}})}
  catch{throw Object.assign(new Error('partial'),{partial:'Your new password is set, but your photos still open only with your passkey. Connect and set the password again to fix this.'})}
}

/** Profile list of passkeys with remove, and adding one for this device's password manager. */
async function passkeySection(me){
  const box=el('div',{class:'stack'}),list=el('div',{class:'stack'});
  box.append(el('p',{class:'label',text:'Passkeys'}),el('p',{class:'hint small',text:'Sign in and open your encrypted photos with your fingerprint, face or screen lock, and choose a new password if you forget yours. Passkeys sync through your password manager, such as Google Password Manager or iCloud Keychain.'}),list);
  const day=t=>t?new Date(t*1000).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}):null;
  let items=[];
  const render=()=>list.replaceChildren(...items.map((item,i)=>el('div',{class:'passkey-item'},
    el('span',{class:'grow'},el('strong',{text:'Passkey '+(i+1)}),el('small',{text:'Added '+day(item.created)+(item.last_used?' · last used '+day(item.last_used):' · not used yet')})),
    button('Remove','btn small ghost',()=>remove(item.credential_id),{'aria-label':'Remove passkey '+(i+1)}))));
  const load=async()=>{try{items=(await api('auth/passkeys')).items}catch{items=[]}render()};
  const remove=async id=>{if(await choiceDialog('Remove this passkey?',['Remove passkey'])!==0)return;
    try{await api('auth/passkeys/'+encodeURIComponent(id),{method:'DELETE'})}catch(e){if(!(e instanceof ApiError&&e.status===404)){toast(message(e,"Couldn't remove the passkey."));return}}
    try{const {record,revision}=await api('vault/key-envelope');if(vault.passkeyIds(record).includes(id))await api('vault/key-envelope',{method:'PUT',body:{base_revision:revision,record:vault.removePasskey(record,id)}})}catch{}
    if(proof?.credentialId===id)proof=null;passkeys.forget(id);toast('Passkey removed');load()};
  const add=button('Add a passkey','btn wide',async()=>{add.disabled=true;
    try{if(await addPasskey(me,items.map(i=>i.credential_id))){toast('Passkey added');await load()}}
    catch(e){const text=passkeyMessage(e,"Couldn't add the passkey.");if(text)toast(text)}finally{add.disabled=false}});
  if(passkeys.available())box.append(add);else box.append(el('p',{class:'hint small',text:"This browser can't use passkeys. Keep your recovery key."}));
  if(proof)box.append(button('Set a new password','btn wide',()=>newPasswordDialog()));
  await load();return box;
}
/** Registers a passkey: its vault copy is saved first, then its sign-in secret, so a passkey that can sign in can always
 * open the vault. Wrappers whose registration never finished are dropped on the way. The server also wants proof beyond
 * the session cookie: this tab's passkey when it signed in or unlocked with a registered one, else the current password. */
async function addPasskey(me,known){
  let confirmed;
  if(proof&&unlocked&&known.includes(proof.credentialId))confirmed={proof_credential_id:proof.credentialId,proof_auth_secret:proof.authSecret};
  else{const secret=await confirmPassword(me);if(!secret)return false;confirmed={password_auth_secret:secret}}
  const {record,revision}=await api('vault/key-envelope');
  const made=await passkeys.create(me,known);
  try{const current={...record,passkeys:(record.passkeys||[]).filter(item=>known.includes(item.credentialId))};
    const next=await vault.addPasskey(unlocked,current,made.credentialId,made.prf);
    await api('vault/key-envelope',{method:'PUT',body:{base_revision:revision,record:next.record}});
    await api('auth/passkeys',{body:{credential_id:made.credentialId,auth_secret:next.authSecret,...confirmed}});
    return true;
  }catch(e){passkeys.forget(made.credentialId);throw e}finally{made.prf.fill(0)}
}
/** One password prompt before adding a passkey. The password opens the vault here (which checks it before a passkey is
 * made) and gives the auth secret the server verifies. Resolves that secret, or null when cancelled. */
function confirmPassword(me){
  return new Promise(resolve=>{
    const d=el('dialog',{class:'dialog'}),note=el('p',{class:'dialog-text',text:'Confirm your password to add a passkey. It never leaves this device.',attrs:{role:'status'}});
    const pass=el('input',{class:'field',type:'password',autocomplete:'current-password',placeholder:'Password',attrs:{'aria-label':'Password'}});
    const go=el('button',{class:'btn primary',type:'submit',text:'Continue'});
    let result=null;const finish=v=>{result=v;d.close()};
    const form=el('form',{},el('h3',{text:'Confirm your password'}),note,pass,el('div',{class:'dialog-actions'},button('Cancel','btn ghost',()=>finish(null)),go));
    form.onsubmit=async e=>{e.preventDefault();const p=pass.value;if(!p){pass.focus();return}go.disabled=true;note.textContent='Checking…';
      try{const params=await api('auth/parameters?name='+encodeURIComponent(me.name)),secret=await vault.deriveAuthSecret(p,params);
        // Check it against the vault without dropping a vault this tab already opened.
        let ok;if(unlocked){const {record}=await api('vault/key-envelope');try{vault.destroy((await vault.unlock(p,record)).vault);ok=true}catch{ok=false}}else ok=await unlock(p);
        if(ok){pass.value='';finish(secret);return}
        note.textContent='That password is not right. Try again.'}
      catch(err){note.textContent=message(err,"Couldn't check the password.")}
      go.disabled=false;pass.select()};
    d.addEventListener('close',()=>{d.remove();resolve(result)});d.append(form);document.body.append(d);d.showModal();setTimeout(()=>pass.focus(),40);
  });
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
  // With password sign-in on, Profile is reachable only once the profile has a password (the server says so in /me).
  const enrolled=me&&'privacy_status' in me;
  const pass=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'New password',attrs:{'aria-label':'New password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const save=button('Set password','btn primary wide',async()=>{const p=pass.value;if(p.length<10){toast('Use at least 10 characters');return}if(p!==again.value){toast("The passwords don't match");return}
    save.disabled=true;try{const r=await enrollPassword(me.name,p,{claim:true});pass.value=again.value='';recoveryKey(r.recoveryKey,()=>toast('Password set. Sign in with '+me.name+' on any device.'));
      if(unlocked)import('./photos.js').then(m=>m.migrate()).catch(()=>{})}
    catch(e){toast(e instanceof ApiError&&e.status===409?'This profile already has a password.':message(e,"Couldn't set the password."))}finally{save.disabled=false}});
  if(!enrolled)c.append(el('p',{class:'hint',text:'Set a password to sign in as '+me.name+' on another device without a link.'}),pass,again,save);
  else c.append(await passkeySection(me));
  if(emailRecovery){let current=null;try{current=await api('auth/email')}catch{}
    const mail=el('input',{class:'field',type:'email',autocomplete:'email',value:current?.email||'',placeholder:'Recovery email (optional)',attrs:{'aria-label':'Recovery email, optional'}});
    const status=el('small',{class:'hint',text:current?.email?(current.verified?'Confirmed.':'Check your inbox to confirm this address.'):''});
    const keep=button('Save email','btn',async()=>{const v=mail.value.trim();if(v&&!validEmail(v)){toast('Check the email address');return}
      try{const r=await saveEmail(v);status.textContent=v?(r?.verified?'Confirmed.':'Check your inbox to confirm this address.'):'';toast(v?'Recovery email saved':'Recovery email removed')}catch(e){toast(message(e,"Couldn't save the email."))}});
    c.append(el('p',{class:'label',text:'Recovery email'}),el('p',{class:'hint small',text:EMAIL_WHY}),mail,status,keep)}
  c.append(row('Sign out',enrolled?'Sign back in with your name and password, or a passkey':'Set a password first, or you will need a new link to get back in',()=>signOut()));
  return c;
}
