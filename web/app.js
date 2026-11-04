// Boot: restore the browser's session or let a new member choose a display name.
// The session lives in an HttpOnly cookie; this page only keeps the account's ID and name to start offline.
import {el,icon,button,toast} from './js/core.js';
import {api,ApiError} from './js/api.js';
import * as store from './js/store.js';
import * as screen from './js/screen.js';
import * as historyView from './js/history.js';
import * as plan from './js/plan.js';
import * as coach from './js/coach.js';
import * as settings from './js/settings.js';
import * as setup from './js/setup.js';
import {nav} from './js/nav.js';
import * as daylight from './js/daylight.js';
import * as auth from './js/auth.js';

daylight.start();daylight.onChange(()=>screen.render());

const app=document.getElementById('app'),params=new URLSearchParams(location.search);
const KNOWN='train-account';
const known=()=>{try{return JSON.parse(localStorage.getItem(KNOWN))}catch{return null}};
const remember=a=>{try{localStorage.setItem(KNOWN,JSON.stringify({id:a.id,name:a.name}))}catch{}};
const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const ios=()=>/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);

Object.assign(nav,{
  setup:()=>setup.open(screen.account(),()=>screen.render()),
  exercise:historyView.exercise,pick:plan.pick,coach:coach.open,finished:screen.finished,workout:id=>historyView.session(id),
  sprint:plan.sprint,sprintList:plan.sprintList,refresh:screen.refresh,profile:screen.profile,begin:screen.begin,dashboard:screen.render,
});

/** A new version takes over as soon as it is deployed: the worker is checked on every open, and the page reloads itself
 * when the new worker takes control, at once if nothing is open, otherwise the next time the app goes to the background. */
function watchForUpdates(){
  navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'}).then(reg=>{
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reg.update().catch(()=>{})});
  }).catch(()=>{});
  if(!navigator.serviceWorker.controller)return;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(!document.querySelector('.page,dialog[open]'))location.reload();
    else document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')location.reload()},{once:true});
  });
}

async function boot(){
  if('serviceWorker' in navigator)watchForUpdates();
  let account=null;
  try{account=await api('me')}
  catch(e){
    if(e instanceof ApiError&&e.status===401){try{localStorage.removeItem(KNOWN)}catch{}if(await auth.enabled())signIn();else join();return}
    if(e instanceof ApiError&&e.status===403&&await auth.enabled()){auth.screen(app,account=>{remember(account);start(account)},{name:known()?.name||''});return}
    account=known();if(!account){app.replaceChildren(el('div',{class:'boot'},el('p',{text:'Connect to the internet to open Iron League for the first time.'})));return}
  }
  if((params.has('switch')||params.has('invite'))&&await auth.enabled()){clean('switch');clean('invite');signIn();return}
  if(params.has('invite')||params.has('switch')){join();return}
  remember(account);start(account);
}
function clean(key){params.delete(key);const q=params.toString();history.replaceState(history.state,'',location.pathname+(q?'?'+q:''))}

function signIn(){auth.screen(app,account=>{remember(account);start(account)})}

function join(){
  const invite=params.get('invite');
  const name=el('input',{class:'field',autocomplete:'nickname',maxLength:80,placeholder:'Your name',attrs:{'aria-label':'Display name',enterkeyhint:'go'}});
  const go=el('button',{class:'btn primary wide',type:'submit',text:'Join Iron League'});
  const note=el('p',{class:'hint',attrs:{role:'status'}});
  const form=el('form',{},name,go,note);
  form.onsubmit=async e=>{e.preventDefault();const n=name.value.trim();if(!n){name.focus();return}go.disabled=true;note.textContent='Joining…';
    try{const account=await api('join',{body:{name:n,invite,switch_profile:true}});clean('invite');clean('switch');remember(account);start(account);
      if(ios()&&!standalone())toast('Now add Iron League to your Home Screen from the Share menu.')}
    catch(err){go.disabled=false;note.textContent=err instanceof ApiError?(invite&&err.status===403?'This profile link is invalid or has expired. Ask for a new link.':err.status===409?'This browser is already joined. Reload Iron League.':err.message||'Your server refused the request.'):'No connection. Try again when you are online.'}};
  const parts=[el('span',{class:'mark'},icon('barbell')),el('h1',{text:'Iron League'}),
    el('p',{class:'hint',text:invite?'Enter your display name.':'Enter the name you use on Iron League. A new name starts a new profile.'}),form];
  if(ios()&&!standalone())parts.push(el('p',{class:'hint small',text:'Join in Safari before adding Iron League to your Home Screen.'}));
  app.replaceChildren(el('main',{class:'join'},...parts));
  setTimeout(()=>name.focus(),60);
}

let frame=0,pushTimer=0;
async function start(account){
  await store.load(account.id);
  screen.mount(app,account);
  // Repaint the dashboard on any change, and send local edits shortly after they settle.
  store.onChange(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(screen.render);if(store.waiting()){clearTimeout(pushTimer);pushTimer=setTimeout(()=>store.sync(),1500)}});
  screen.refresh();
  settings.load().then(()=>screen.render());
  if(account.setup_complete===false)setup.open(account,()=>screen.render());
  addEventListener('online',()=>screen.refresh());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')screen.refresh()});
  setInterval(()=>{if(document.visibilityState==='visible')store.sync()},60000);
  if(params.has('reminder')){const id=params.get('reminder');clean('reminder');screen.reminder(id)}
  if(params.has('friend')){const id=params.get('friend');clean('friend');screen.friend(id,'ranks')}
  navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.reminder)screen.reminder(e.data.reminder);if(e.data?.friend)screen.friend(e.data.friend,'ranks')});
}
boot();
