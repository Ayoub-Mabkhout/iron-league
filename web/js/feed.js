// Friends' explicitly shared workout posts. Progress-vault photos never enter this feed.
import {el,icon,button,page,clock,plural,uid,confirmDialog,toast} from './core.js';
import {api,ApiError} from './api.js';
import * as units from './units.js';

const date=value=>new Date(typeof value==='number'?value*1000:value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const initials=name=>name.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase();
const monogram=name=>el('span',{class:'feed-monogram',text:initials(name),attrs:{'aria-hidden':'true'}});
const count=n=>plural(n,'comment');

export function open(viewer){
  const p=page('Workout feed',{cls:'workout-feed'});
  const list=el('div',{class:'stack',attrs:{'aria-label':'Shared workouts'}});
  const status=el('p',{class:'hint',attrs:{role:'status'}});
  const more=button('Load more','btn quiet wide',load);
  let cursor=null,loaded=false,busy=false;
  p.body.append(list,status,more);
  load();
  async function load(){
    if(busy)return;
    busy=more.disabled=true;status.textContent='Loading workouts…';
    try{
      const query=cursor==null?'':'&before='+encodeURIComponent(cursor);
      const {items,next_cursor}=await api('feed?limit=20'+query);
      if(p.closed)return;
      for(const item of items)list.append(post(item,viewer));
      loaded=loaded||items.length>0;cursor=next_cursor;
      status.textContent=loaded?'':'Shared workouts will appear here.';
      more.hidden=cursor==null;more.textContent='Load more';
    }catch(error){
      status.textContent=error instanceof ApiError&&error.status===404?'The workout feed is not available yet.':'Could not load workouts. Check your connection and retry.';
      more.textContent='Retry';
    }finally{busy=more.disabled=false}
  }
}

function post(item,viewer){
  const athlete=item.athlete.name;
  const pic=el('img',{class:'feed-image',loading:'lazy',decoding:'async',alt:athlete+' training',src:item.photo_url});
  const exercises=el('div',{class:'feed-exercises'},...item.exercises.map(exercise));
  const notes=button(el('span',{},icon('chat'),el('span',{text:count(item.comment_count||0)})),'btn quiet',()=>comments(item,viewer,notes));
  return el('article',{class:'feed-card'},el('header',{class:'feed-person'},monogram(athlete),
    el('div',{class:'grow'},el('strong',{text:athlete}),el('time',{text:date(item.started_at),dateTime:item.started_at}))),
    pic,el('div',{class:'feed-details'},el('h3',{text:item.name}),
      el('p',{class:'hint',text:[item.duration_seconds>0?clock(item.duration_seconds):'',plural(item.exercises.length,'exercise')].filter(Boolean).join(' · ')}),
      el('details',{},el('summary',{text:'Workout details'}),exercises),notes));
}
function exercise(exercise){
  const sets=exercise.sets.map(set=>{
    const parts=[set.distance_m==null?'':units.distance(set.distance_m),set.seconds==null?'':clock(set.seconds)];
    if(set.reps!=null)parts.push(set.weight_kg==null?plural(set.reps,'rep'):set.reps+' × '+units.load(set.weight_kg));
    return parts.filter(Boolean).join(' · ')||'Set logged';
  });
  return el('div',{class:'feed-exercise'},el('strong',{text:exercise.name}),el('small',{text:sets.join(' / ')}));
}

function comments(item,viewer,trigger){
  const p=page('Comments',{cls:'feed-comments'});
  const path='feed/'+encodeURIComponent(item.id)+'/comments';
  const list=el('div',{class:'stack',attrs:{'aria-label':'Workout comments','aria-live':'polite'}});
  const status=el('p',{class:'hint',attrs:{role:'status'}});
  const more=button('Load more','btn quiet wide',load);more.hidden=true;
  const input=el('textarea',{class:'field',maxLength:1000,rows:2,placeholder:'Add a comment',attrs:{'aria-label':'Your comment'}});
  const send=el('button',{type:'submit',class:'btn primary',text:'Post'});
  const form=el('form',{class:'feed-comment-form'},input,send);
  const rows=new Map();
  let cursor=null,busy=false,pending=null;
  p.body.append(el('p',{class:'hint',text:item.athlete.name+' · '+item.name}),list,more,status,form);
  form.onsubmit=async event=>{
    event.preventDefault();const value=input.value.trim();
    if(send.disabled||!value)return;
    if(pending?.text!==value)pending={text:value,client_id:uid()};
    send.disabled=input.disabled=true;status.textContent='';
    try{
      const comment=await api(path,{body:pending});
      if(!rows.has(comment.id)){render(comment);updateCount(1)}
      pending=null;input.value='';
    }catch{status.textContent='Could not post. Your comment is still here. Tap Post to retry.'}
    finally{send.disabled=input.disabled=false}
  };
  load();
  async function load(){
    if(busy)return;
    busy=more.disabled=true;status.textContent='Loading comments…';
    try{
      const query=cursor==null?'':'&after='+encodeURIComponent(cursor);
      const result=await api(path+'?limit=50'+query);
      for(const comment of result.items)render(comment);
      cursor=result.next_cursor;more.hidden=cursor==null;more.textContent='Load more';
      status.textContent=rows.size?'':'No comments yet.';
    }catch{status.textContent='Could not load comments.';more.hidden=false;more.textContent='Retry'}
    finally{busy=more.disabled=false}
  }
  function updateCount(delta){
    item.comment_count=Math.max(0,(item.comment_count||0)+delta);
    trigger.querySelector('span span').textContent=count(item.comment_count);
  }
  function render(comment){
    if(rows.has(comment.id))return;
    const remove=viewer?.id===comment.author.id||viewer?.id===item.athlete.id;
    const row=el('article',{class:'feed-comment'},monogram(comment.author.name),
      el('div',{class:'grow'},el('strong',{text:comment.author.name}),el('small',{text:date(comment.created_at)}),
        el('p',{text:comment.text})),remove?button('Delete','btn ghost',async()=>{
        if(!await confirmDialog('Delete comment?','','Delete','Cancel',true))return;
        try{await api(path+'/'+encodeURIComponent(comment.id),{method:'DELETE'});rows.delete(comment.id);row.remove();updateCount(-1)}
        catch{toast('Could not delete this comment.')}
      }):null);
    const next=[...rows.keys()].filter(id=>Number(id)>Number(comment.id)).sort((a,b)=>Number(a)-Number(b))[0];
    if(next!=null)list.insertBefore(row,rows.get(next));else list.append(row);
    rows.set(comment.id,row);
  }
}
