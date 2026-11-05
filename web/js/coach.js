// One durable conversation, as in the Android Companion's Coach. The relay accepts questions while the coach is offline.
// A sent message shows at once and keeps its ID until the server confirms it, so a retry never asks twice; the coach's
// answer streams into one bubble that becomes the final answer. Photos reach the coach only through an explicit,
// per-question share of an encrypted photo (photos.js); the server deletes that copy once the answer is written.
import {el,page,toast,uid,clock} from './core.js';
import * as store from './store.js';
import * as units from './units.js';
import {api,ApiError} from './api.js';
import {tile} from './art.js';
import {markdown} from './markdown.js';
import {nav} from './nav.js';
import * as photoStore from './photos.js';
import {choosePhotos} from './body.js';
import {composer,preview} from './composer.js';

const PENDING='train-coach-pending',DRAFT='train-coach-draft',MAX_PHOTOS=6,PHOTOS_ONLY='Please look at the attached photos.';
const read=k=>{try{return JSON.parse(sessionStorage.getItem(k))||{}}catch{return {}}};
const keep=(k,v)=>{try{if(v)sessionStorage.setItem(k,JSON.stringify(v));else sessionStorage.removeItem(k)}catch{}};
const BRIEFS=['next_session_brief','sprint_brief'];
/** "5 Nov, 14:02" as on Android, with the year when it isn't this one. */
const stamp=s=>{if(!s)return '';const d=new Date(s*1000);return d.toLocaleString(undefined,{day:'numeric',month:'short',...(d.getFullYear()===new Date().getFullYear()?{}:{year:'numeric'}),hour:'2-digit',minute:'2-digit'})};
class Refused extends Error{}

/** The coach worker's readiness from the conversation's status: online, unavailable (running but paused, for example out
 * of model allowance) or offline. Null means the relay itself couldn't be reached. */
export function readiness(s){
  if(s===null)return {text:'No connection',tone:'warning',note:'Iron League can’t reach your server. Messages you send stay as drafts.'};
  if(!s)return {text:'Coach · Checking…',tone:'',note:''};
  if(s.available)return {text:'Coach online',tone:'success',note:s.state==='busy'?'Your coach is answering.':'Your coach is ready.'};
  const recent=s.last_seen&&Date.now()/1000-s.last_seen<90;
  return recent?{text:'Coach unavailable',tone:'warning',note:'Your coach is paused, for example out of model allowance. Messages wait and are answered when it’s back.'}
    :{text:'Coach offline',tone:'warning',note:'Your coach isn’t connected. Messages wait and are answered when it’s back.'};
}

/** context may carry current_workout_id, sprint_id or template_id; the server ignores anything else from a browser. */
export function open(context={},live=null,prefill='',photos=[]){
  const wire={};for(const k of ['current_workout_id','sprint_id','template_id'])if(context[k])wire[k]=context[k];
  const saved=read(DRAFT),prior=read(PENDING);
  let attached=(photos.length?photos:prefill?[]:saved.photos||[]).filter(id=>store.data('photo',id)).slice(0,MAX_PHOTOS);
  const chip=el('span',{class:'chip-status',attrs:{role:'status'}},el('span',{class:'dot'}),el('span',{}));
  const p=page('Coach',{cls:'coach',actions:[chip],onclose:()=>{clearTimeout(timer);controller?.abort();box?.stop();document.removeEventListener('visibilitychange',wake);resize.disconnect();document.documentElement.style.removeProperty('--composer')}});
  const items=el('div',{class:'chat',attrs:{'aria-live':'polite','aria-relevant':'additions text'}});p.body.append(items);

  // The shared composer: attached photos, the message, then attach, dictation and Send.
  const remember=()=>keep(DRAFT,box.input.value||attached.length?{text:box.input.value,photos:attached}:null);
  const box=composer({label:'Ask your coach',placeholder:'Ask your coach',value:prefill||saved.text||prior.text||'',maxLength:8000,
    onSend:ask,onInput:remember,onAttach:choose,attachLabel:'Attach photos'});
  const input=box.input,fit=box.fit;
  const bar=el('footer',{class:'chat-bar'},box.root);p.root.append(bar);
  async function choose(){
    if(sending)return;
    const ids=await choosePhotos(attached,{title:'Attach photos',limit:MAX_PHOTOS,many:'six',action:'Attach to message',
      intro:'Choose progress photos for this question.',note:'When you send, a copy of each is shared with your coach for this question only and deleted once it answers.',
      count:n=>n+(n===1?' photo':' photos')+' for this question.'});
    if(ids){attached=ids;paintFiles();remember()}
    setTimeout(()=>box.focus(),60);
  }
  function paintFiles(){
    const shown=attached.map(id=>{const data=store.data('photo',id);return data?preview(photoStore.img({id,data},{alt:'Attached photo'}),'Remove photo',()=>{attached=attached.filter(a=>a!==id);paintFiles();remember()}):null}).filter(Boolean);
    box.files(shown,shown.length?(shown.length===1?'1 photo':shown.length+' photos')+'. Your coach gets a copy for this question only.':'');
  }
  paintFiles();

  // Follow the newest message while the reader is at the end, including when the keyboard or the composer resizes the list.
  let stick=true;
  const atEnd=()=>p.body.scrollTop+p.body.clientHeight>=p.body.scrollHeight-80;
  const toEnd=()=>p.body.scrollTo({top:p.body.scrollHeight,behavior:'auto'});
  p.body.addEventListener('scroll',()=>{stick=atEnd()},{passive:true});
  // Toasts rise above the composer while the chat is open.
  const resize=new ResizeObserver(()=>{if(stick)toEnd();document.documentElement.style.setProperty('--composer',bar.offsetHeight+'px')});resize.observe(p.body);resize.observe(items);resize.observe(bar);

  // The relay holds each request open until something in the conversation changes, so replies and each streamed revision
  // appear as soon as they are written. An older relay without versions falls back to a 5 s timer; errors back off from
  // 2 s to 30 s. A request that hangs counts as a failure, so the status chip never stays on "Checking".
  let timer=0,version=null,controller=null,backoff=0,online=false,latest=[],sending=false;
  const local=new Map(),rendered=new Map();
  if(prior.id)local.set(prior.id,{id:prior.id,question:prior.text,photos:prior.photos||[],created:prior.created,state:'unconfirmed'});
  function status(s){const r=readiness(s);chip.lastChild.textContent=r.text;chip.dataset.tone=r.tone;chip.dataset.on=String(r.tone==='success');chip.title=r.note;chip.setAttribute('aria-label',r.text+(r.note?'. '+r.note:''))}
  status(undefined);
  async function poll(){
    if(p.closed||document.visibilityState==='hidden')return;
    controller=new AbortController();const mine=controller,waiting=version!=null;let delay=5000;
    const limit=setTimeout(()=>mine.abort('timeout'),waiting?45000:12000);
    try{const r=await api('trainer/conversation?limit=50'+(waiting?'&since='+encodeURIComponent(version)+'&wait=25':''),{signal:mine.signal});
      if(mine!==controller)return;backoff=0;
      online=!!r.status?.available;status(r.status||{available:false});latest=r.items||[];
      for(const q of latest){local.delete(q.id);if(!sending&&read(PENDING).id===q.id)delivered()}
      display();
      if(r.version!=null){version=r.version;delay=0}}
    catch{if(mine!==controller||mine.signal.aborted&&mine.signal.reason!=='timeout')return;// The next request asks for the current view at once, so the chip recovers as soon as the server answers.
      online=false;version=null;status(null);display();backoff=Math.min(30000,backoff?backoff*2:2000);delay=backoff}
    finally{clearTimeout(limit)}
    if(mine===controller&&!p.closed)timer=setTimeout(poll,delay);
  }
  /** Ask again right away, dropping any request still held open. */
  function restart(){clearTimeout(timer);controller?.abort();controller=null;poll()}
  const wake=()=>{if(document.visibilityState==='visible')restart();else{clearTimeout(timer);controller?.abort();controller=null}};
  document.addEventListener('visibilitychange',wake);

  async function ask(){
    if(sending)return;
    const typed=input.value.trim();if(!typed&&!attached.length)return;
    const text=typed||PHOTOS_ONLY,chosen=attached.slice();
    // The same message keeps its ID across retries, so a lost reply can't ask it twice; the server returns the first one.
    const key=JSON.stringify([text,wire,chosen]),before=read(PENDING),id=before.key===key?before.id:uid(),created=before.key===key&&before.created||Date.now()/1000;
    keep(PENDING,{key,id,text,photos:chosen,created});
    for(const [k,v] of local)if(k!==id&&v.state==='unconfirmed')local.delete(k);
    local.set(id,{id,question:text,photos:chosen,created,state:'sending'});stick=true;display();busy(true);
    try{
      // Encrypted photos get a plaintext copy for this question only; the server deletes it once the answer is written.
      for(const photo of chosen){const data=store.data('photo',photo);if(!data)throw new Refused('A chosen photo was deleted. Remove it and send again.');
        if(!await photoStore.share({id:photo,data}))throw new Refused('Unlock your photos to ask about them.')}
      const problem=await store.sync();if(problem)throw new Error(problem);
      const result=await api('trainer/questions',{body:{id,text,photos:chosen,photo_approval:chosen.length>0,context:wire}});
      if(local.has(id))local.get(id).state='queued';
      if(!online)toast('Message queued. The reply will appear in this chat.');
      delivered();display();restart()}
    catch(e){
      // The reply was lost but the conversation already shows the message: it was sent.
      if(latest.some(q=>q.id===id)){delivered();display();return}
      if(local.has(id))local.get(id).state='unconfirmed';display();
      toast(e instanceof Refused?e.message:e instanceof ApiError?(e.status===409?'Couldn’t queue this message. Your draft is still here.':'Your server refused the question.'+(e.message?' '+e.message:'')):'No connection. Your draft is still here. Tap Send when connected.')}
    finally{busy(false)}
  }
  /** The pending message reached the server: clear the composer if it still holds that message, so Send can't repeat it. */
  function delivered(){
    const pend=read(PENDING);keep(PENDING,null);
    const typed=input.value.trim(),same=pend.text&&(typed===pend.text||!typed&&pend.text===PHOTOS_ONLY)&&JSON.stringify(pend.photos||[])===JSON.stringify(attached);
    if(same){
      input.value='';fit();attached=[];paintFiles();keep(DRAFT,null)}
  }
  function busy(on){sending=on;box.busy(on)}

  /** The server's conversation plus messages it hasn't confirmed yet, oldest first. */
  function display(){
    const ids=new Set(latest.map(q=>q.id)),merged=[...latest,...[...local.values()].filter(q=>!ids.has(q.id))];
    const end=stick||atEnd();paint(merged);if(end){stick=true;requestAnimationFrame(toEnd)}
  }
  function paint(list){
    const shown=list.filter(q=>!BRIEFS.includes(q.context?.purpose));
    if(!shown.length){rendered.clear();items.replaceChildren(el('p',{class:'empty',text:online?'Ask about a swap, fatigue, pain or your plan.':'The coach is offline. You can still send a message. The reply will appear in this chat when the coach is back.'}));return}
    const wanted=[];
    for(const q of shown){let entry=rendered.get(q.id);
      if(!entry){entry={mine:el('div',{class:'msg mine'}),answer:el('div'),asked:'',signature:''};rendered.set(q.id,entry)}
      const asked=JSON.stringify([q.question,q.photos,q.created]);
      if(asked!==entry.asked){entry.asked=asked;entry.mine.replaceChildren(el('p',{class:'msg-meta',text:'You'+(q.created?' · '+stamp(q.created):'')}),el('p',{class:'msg-text',text:q.question}),thumbs(q.photos))}
      const signature=JSON.stringify([q.state,q.answer,q.partial_answer,q.answered_at,q.approved,q.proposals,online]);
      if(signature!==entry.signature){entry.signature=signature;answer(entry.answer,q)}
      wanted.push(entry.mine,entry.answer);
    }
    // Keep the same bubbles attached as text arrives, including the user's scroll position and composer focus.
    for(let i=0;i<wanted.length;i++)if(items.children[i]!==wanted[i])items.insertBefore(wanted[i],items.children[i]||null);
    while(items.children.length>wanted.length)items.lastElementChild.remove();
    const keepIds=new Set(shown.map(q=>q.id));for(const id of rendered.keys())if(!keepIds.has(id))rendered.delete(id);
  }
  /** One node per question: a status line, then the coach's bubble, which streamed text fills in place until it's final. */
  function answer(c,q){
    const done=q.state==='completed',streaming=q.state==='running'&&!!q.partial_answer;
    c.setAttribute('aria-busy',String(q.state==='running'||q.state==='sending'));
    if(done||streaming){
      const meta=done?'Coach'+(q.answered_at?' · '+stamp(q.answered_at):''):'Coach · Answering…';
      if(!c.classList.contains('coach')){c.className='msg coach';c.replaceChildren(el('p',{class:'msg-meta'}),el('div',{class:'md'}))}
      c.firstChild.textContent=meta;c.children[1].replaceChildren(markdown(done?q.answer:q.partial_answer));
      while(c.children.length>2)c.lastChild.remove();
      if(done)proposals(c,q);return}
    const warn=q.state==='failed'||q.state==='unconfirmed';
    c.className='msg-state'+(warn?' warn':'');
    c.textContent=q.state==='sending'?'Sending…':q.state==='unconfirmed'?'Not confirmed. Your draft is saved; tap Send to retry.':q.state==='failed'?"Your coach couldn't answer. Try again.":
      q.state==='queued'?(online?'Queued. The reply will appear here.':'Queued. The reply will appear here when the coach is back online.'):'Your coach is thinking…';
  }
  function thumbs(ids){
    const rows=(ids||[]).map(id=>{const data=store.data('photo',id);return data?{id,data}:null}).filter(Boolean);
    return rows.length?el('div',{class:'msg-photos'},...rows.map(r=>photoStore.img(r,{alt:'Attached photo',loading:'lazy'}))):null;
  }
  /** Shows what each proposal would change next to what's there now; Apply takes them all, once. */
  function proposals(c,q){
    const list=q.proposals||[];if(!list.length)return;const done=!!q.approved;
    c.append(el('p',{class:'proposal-title',text:'Proposed changes'}));
    for(const x of list){const now=store.data(x.kind,x.id);if(x.kind==='exercise'&&x.data)c.append(tile(x.data,64));
      c.append(el('p',{class:'proposal before',text:'Before: '+describe(x.kind,now)}),el('p',{class:'proposal after'+(x.deleted?' deleted':''),text:x.deleted?'After: deleted.'+(x.kind==='workout'?' Sprint progress and your next workout recalculate.':''):'After: '+describe(x.kind,x.data)}))}
    if(done){c.append(el('p',{class:'applied',text:'Applied'}));return}
    const apply=el('button',{type:'button',class:'btn quiet',text:'Apply changes'});
    apply.onclick=async()=>{
      if(live&&!live.matchesSaved()){toast('Your workout changed since your coach saw it. Ask again before applying changes.');return}
      apply.disabled=true;
      try{await api(`trainer/${encodeURIComponent(q.id)}/approve`,{body:{}});await store.sync();
        if(live)for(const x of list)if(x.kind==='workout'&&x.id===live.d.workout_id){if(x.deleted)live.discard();else live.adopt(x.data)}
        nav.refresh();restart()}
      catch(e){toast(e instanceof ApiError?(e.status===409?'That changed since your coach answered. Ask again.':'Your server refused the change.'):'No connection. Nothing changed.')}
      finally{apply.disabled=false}};
    c.append(apply);
  }
  display();poll();setTimeout(()=>input.focus({preventScroll:true}),120);
}
function describe(kind,d){
  if(!d)return 'new '+kind;
  if(kind==='sprint')return d.name+' · '+d.phase+' · '+(d.target_sessions||0)+' workouts until '+d.end+(d.cycle?' · cycle of '+d.cycle.length:'');
  if(kind==='template')return d.name+((d.exercises||[]).length?': '+d.exercises.map(p=>store.exerciseName(p.exercise_id)+' '+(p.sets||1)+'×'+(p.min_reps??'')).join(', '):'');
  if(kind!=='workout')return d.name||kind;
  const rows=new Map();for(const x of d.sets||[]){const n=store.exerciseName(x.exercise_id);if(!rows.has(n))rows.set(n,[]);
    rows.get(n).push((x.distance_m!=null?units.distance(x.distance_m)+' in '+clock(x.seconds):(x.weight_kg!=null?units.load(x.weight_kg)+' × ':'')+(x.reps??0))+(x.completed===false?' (open)':''))}
  return [...rows].map(([n,v])=>n+': '+v.join(', ')).join('; ')||d.name;
}
