// Name and password sign-in. The password stays on this device: it derives an auth secret (PBKDF2 then HKDF, in
// private-vault.js) and only that secret is sent. After signing in, the private vault is unlocked in memory for this tab.
import {el,icon,button,toast,card,row} from './core.js';
import {api,ApiError} from './api.js';
import * as vault from './private-vault.js';

let available=null,unlocked=null;
/** Whether this server has password sign-in switched on; it answers 404 while the feature is off. */
export async function enabled(){
  if(available!==null)return available;
  try{await api('auth/parameters?name=probe');available=true}catch(e){available=e instanceof ApiError&&e.status!==404}
  return available;
}
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
  const tabs=el('div',{class:'segmented',attrs:{role:'tablist'}}),form=el('form',{class:'auth-form'},name,pass,again,go,note);
  const show=m=>{mode=m;note.textContent='';again.hidden=m==='signin';pass.autocomplete=m==='signin'?'current-password':'new-password';go.textContent={signin:'Sign in',create:'Create profile',claim:'Set password'}[m];
    if(m==='claim'){tabs.hidden=true;return}
    tabs.replaceChildren(...[['signin','Sign in'],['create','New profile']].map(([k,t])=>{const b=el('button',{type:'button',class:'seg'+(k===m?' on':''),text:t,attrs:{role:'tab','aria-selected':String(k===m)}});b.onclick=()=>show(k);return b}))};
  form.onsubmit=async e=>{e.preventDefault();const n=name.value.trim(),p=pass.value;
    if(!n){name.focus();return}if(!p){pass.focus();return}
    if(mode!=='signin'){if(p.length<10){note.textContent='Use at least 10 characters.';pass.focus();return}if(p!==again.value){note.textContent="The passwords don't match.";again.focus();return}}
    go.disabled=true;note.textContent={signin:'Signing in…',create:'Creating your profile…',claim:'Setting your password…'}[mode];
    try{if(mode==='signin')done(await signIn(n,p));else{const r=await enrollPassword(n,p,{claim:mode==='claim'});recoveryKey(r.recoveryKey,()=>done(r.account))}}
    catch(err){go.disabled=false;note.textContent=mode!=='signin'&&err instanceof ApiError&&err.status===409?(mode==='claim'?'Enter the name this profile uses, exactly as shown in Friends.':'That name is taken. Sign in, or choose another name.'):message(err,'Your server refused the request.')}};
  if(claim?.name)name.value=claim.name;show(mode);
  root.replaceChildren(el('main',{class:'join'},el('span',{class:'mark'},icon('barbell')),el('h1',{text:claim?'Set a password':'Iron League'}),
    el('p',{class:'hint',text:claim?'Iron League now signs in with your name and a password. Your workouts stay with this profile, and the password never leaves this device.':'Your password never leaves this device.'}),tabs,form));
  setTimeout(()=>(claim?.name?pass:name).focus(),60);
}

/** Shown once after a password is set: the only copy of the key that can reopen private records without the password. */
export function recoveryKey(key,next){
  if(!key){next();return}
  const d=el('dialog',{class:'dialog recovery'});const code=el('code',{class:'recovery-key',text:key.match(/.{1,4}/g).join(' ')});
  const copy=button('Copy','btn',async()=>{try{await navigator.clipboard.writeText(key);toast('Recovery key copied')}catch{toast('Select the key and copy it')}});
  const ok=button("I've saved it",'btn primary wide',()=>{d.close();d.remove();next()});
  d.append(el('h3',{text:'Save your recovery key'}),el('p',{class:'dialog-text',text:'Keep it somewhere safe, like a password manager. It is the only way to open your private records if you forget your password, and Iron League cannot show it again.'}),code,copy,ok);
  d.addEventListener('cancel',e=>e.preventDefault());document.body.append(d);d.showModal();
}

/** Profile card: set a password for a profile joined by link, or sign out. */
export async function accountCard(me){
  if(!await enabled())return null;
  const c=card(el('h3',{class:'card-title',text:'Sign-in'}));
  const pass=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'New password',attrs:{'aria-label':'New password'}});
  const again=el('input',{class:'field',type:'password',autocomplete:'new-password',placeholder:'Repeat password',attrs:{'aria-label':'Repeat password'}});
  const save=button('Set password','btn primary wide',async()=>{const p=pass.value;if(p.length<10){toast('Use at least 10 characters');return}if(p!==again.value){toast("The passwords don't match");return}
    save.disabled=true;try{const r=await enrollPassword(me.name,p,{claim:true});pass.value=again.value='';recoveryKey(r.recoveryKey,()=>toast('Password set. Sign in with '+me.name+' on any device.'))}
    catch(e){toast(e instanceof ApiError&&e.status===409?'This profile already has a password.':message(e,"Couldn't set the password."))}finally{save.disabled=false}});
  c.append(el('p',{class:'hint',text:'Set a password to sign in as '+me.name+' on another device without a link.'}),pass,again,save,
    row('Sign out','Set a password first, or you will need a new link to get back in',()=>signOut()));
  return c;
}
