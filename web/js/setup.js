// First run for a new member, after the name from the join screen: body stats, two opt-ins, then the coach plans the first sprint.
// Everything here can be changed later in Profile. Backing out leaves a clear way back from the dashboard.
import {el,icon,button,page,toast,uid,haptic,confirmDialog} from './core.js';
import * as store from './store.js';
import * as units from './units.js';
import {api} from './api.js';
import * as settings from './settings.js';
import {iso} from './live.js';
import {nav} from './nav.js';
import {choosePhotos} from './body.js';
import {saveReminderPhotos} from './photos.js';

export const FIRST_SPRINT='Plan my first sprint. Ask me what I need to know about my goals, schedule and equipment, then propose the sprint and any exercises it needs.';
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';

export function open(account,done){
  const p=page('Welcome',{cls:'setup'});
  const athlete=store.athlete(),latestKg=store.overview().bodyweight?.latest?.kg;
  const savedSettings=settings.get();
  const initialStats={imperial:athlete.units==='imperial',age:athlete.age_years??'',height:athlete.height_cm,kg:latestKg,sex:athlete.sex||'unspecified'};
  let step=0,statsDraft=initialStats,choicesDraft={...savedSettings},saving=false;
  let queuedAthlete='',queuedWeight=latestKg;
  const weightId=uid();
  const status=el('p',{class:'hint',attrs:{role:'status'}});
  function go(stepIndex){step=stepIndex;status.textContent='';paint()}
  const dots=el('div',{class:'steps',attrs:{'aria-hidden':'true'}},el('span'),el('span'),el('span'));
  const body=el('div',{class:'stack'});p.body.append(dots,body);
  const paint=()=>{[...dots.children].forEach((d,i)=>d.classList.toggle('on',i<=step));body.replaceChildren(...[stats,choices,coach][step]());p.body.scrollTop=0;body.querySelector('input,select,button')?.focus({preventScroll:true})};

  /** Age and body stats, in the units the member picks. They feed ranks and the coach. */
  function stats(){
    let imperial=statsDraft.imperial;
    const seg=el('div',{class:'segmented'});const unitBtn=(label,on)=>{const b=el('button',{type:'button',class:'seg'+(on===imperial?' on':''),text:label,attrs:{'aria-pressed':String(on===imperial)}});b.onclick=()=>{if(on!==imperial){imperial=on;relabel(true)}};return b};
    const age=el('input',{class:'field',type:'number',min:13,max:100,value:statsDraft.age,attrs:{'aria-label':'Age in years',inputmode:'numeric'}});
    const height=el('input',{class:'field',value:'',attrs:{inputmode:'decimal'}}),weight=el('input',{class:'field',value:'',attrs:{inputmode:'decimal'}});
    const hl=el('span'),wl=el('span');
    const sex=el('select',{class:'field',attrs:{'aria-label':'Sex, used for ranks'}},...[['unspecified','Prefer not to say'],['female','Female'],['male','Male']].map(([v,t])=>el('option',{value:v,text:t,selected:statsDraft.sex===v})));
    const convert=(value,factor)=>value==null?'':String(Math.round(value*factor*10)/10);
    height.value=convert(statsDraft.height,imperial?1/2.54:1);
    weight.value=convert(statsDraft.kg,imperial?1/units.LB:1);
    function relabel(convertValues=false){
      if(convertValues){
        height.value=convert(num(height.value),imperial?1/2.54:2.54);
        weight.value=convert(num(weight.value),imperial?1/units.LB:units.LB);
      }
      seg.replaceChildren(unitBtn('Metric',false),unitBtn('Imperial',true));
      hl.textContent='Height ('+(imperial?'in':'cm')+')';
      wl.textContent='Weight ('+(imperial?'lb':'kg')+')';
      height.setAttribute('aria-label',hl.textContent);
      weight.setAttribute('aria-label',wl.textContent);
    }
    relabel();
    const next=button('Continue','btn primary wide',()=>{
      const y=num(age.value),h=num(height.value),w=num(weight.value);
      const cm=h==null?null:Math.round((imperial?h*2.54:h)*10)/10;
      const kg=w==null?null:Math.round((imperial?w*units.LB:w)*100)/100;
      if(age.value&&(y==null||y<13||y>100||!Number.isInteger(y))){toast('Enter your age in whole years from 13 to 100.');age.focus();return}
      if(height.value.trim()&&(cm==null||cm<=0||cm>300)){toast('Enter a valid height.');height.focus();return}
      if(weight.value.trim()&&(kg==null||kg<=0||kg>1000)){toast('Enter a valid weight.');weight.focus();return}
      statsDraft={imperial,age:y,height:cm,kg,sex:sex.value};
      go(1);
    });
    return [el('h2',{class:'setup-title',text:'About you'}),el('p',{class:'hint',text:'Ranks compare you with lifters of your sex and bodyweight. Your coach uses all of this. Leave anything blank you would rather not share.'}),
      settings.privacyCard('h3'),seg,el('label',{class:'field-label'},el('span',{text:'Age'}),age),el('div',{class:'row2'},el('label',{class:'field-label'},hl,height),el('label',{class:'field-label'},wl,weight)),
      el('label',{class:'field-label'},el('span',{text:'Sex'}),sex),next];
  }
  /** Two independent opt-ins, both off unless chosen. */
  function choices(){
    const v=choicesDraft;
    const diss=toggle('Diss mode','Crude, profane nudges when you skip a session, and blunt briefs when you fall short of the plan.',!!v.roast);
    const timed=toggle('Scheduled sprints','Book dated sessions with start times and get a reminder before each one. Off keeps a simple repeating cycle.',!!v.scheduled_sprints);
    const photos=toggle('Reminder photos','Let Diss mode reminders show private photos you choose. Off by default.',!!v.photos_enabled);let ids=[...(v.photo_ids||[])];
    const choose=button('Choose photos','btn quiet wide',async()=>{const r=await choosePhotos(ids);if(r){ids=r;choose.textContent=ids.length?ids.length+(ids.length===1?' photo chosen':' photos chosen'):'Choose photos'}});
    if(ids.length)choose.textContent=ids.length+(ids.length===1?' photo chosen':' photos chosen');
    const remember=()=>{choicesDraft={roast:diss.input.checked,scheduled_sprints:timed.input.checked,photos_enabled:diss.input.checked&&photos.input.checked,photo_ids:ids}};
    const extra=el('div',{class:'stack nested'});const sync=()=>{extra.hidden=!diss.input.checked;extra.replaceChildren(...[photos.el,photos.input.checked?choose:null].filter(Boolean))};
    diss.input.onchange=async()=>{if(diss.input.checked&&!await confirmDialog('Turn on Diss mode?','Reminders and some briefs may use crude, profane language. You can turn it off any time in Profile.','Turn on','Cancel'))diss.input.checked=false;sync()};
    photos.input.onchange=sync;sync();
    return [el('h2',{class:'setup-title',text:'How Iron League treats you'}),el('p',{class:'hint',text:'Both stay off unless you turn them on. You can change either one later in Profile.'}),
      el('div',{class:'card'},diss.el,extra,timed.el),
      button('Continue','btn primary wide',()=>{remember();go(2)}),
      button('Back','btn ghost wide',()=>{remember();go(0)})];
  }
  function coach(){
    const next=button('Talk to your coach','btn primary wide',()=>finish(next,back));
    const back=button('Back','btn ghost wide',()=>go(1));
    return [el('div',{class:'setup-coach'},icon('sparkle')),el('h2',{class:'setup-title',text:'Plan your first sprint'}),
      el('p',{class:'hint',text:'Your coach asks about your goals, the days you can train and your equipment, then proposes a sprint. Nothing changes until you approve it. If the coach is offline, send your message now and return here for the reply.'}),
      next,back,status];
  }
  async function finish(next,back){
    if(saving)return;
    saving=next.disabled=back.disabled=true;
    status.textContent='Saving your profile…';
    try{
      const {imperial,age,height,kg,sex}=statsDraft;
      const updated={...athlete,units:imperial?'imperial':'metric',age_years:age,height_cm:height,sex};
      const signature=JSON.stringify(updated);
      if(signature!==queuedAthlete){
        store.putEntity('athlete','self',updated);
        queuedAthlete=signature;
      }
      if(kg!=null&&kg!==queuedWeight){
        store.putEntity('measurement',weightId,{measured_at:iso(Date.now(),zone()),kind:'bodyweight',value:kg,unit:'kg',source:'Iron League web'});
        queuedWeight=kg;
      }
      if(await store.sync()||store.conflicts().some(item=>item.kind==='athlete'||item.id===weightId))throw new Error('stats');
      const saved=await saveReminderPhotos(savedSettings.photo_ids||[],choicesDraft.photo_ids||[],()=>settings.save(choicesDraft));
      if(!saved)throw new Error('preferences');
      const result=await api('me',{method:'PATCH',body:{setup_complete:true}});
      if(result.setup_complete!==true)throw new Error('completion');
      account.setup_complete=true;
      if(p.closed){done?.(account);return}
      haptic(12);p.onclose=null;p.close();done?.(account);nav.coach({},null,FIRST_SPRINT);
    }catch{
      status.textContent='Setup is still open. Check your connection and tap Talk to your coach to retry.';
    }finally{saving=next.disabled=back.disabled=false}
  }
  p.onclose=()=>done?.(account);
  paint();
}
const num=v=>{const t=String(v).trim().replace(',','.');if(!t)return null;const n=Number(t);return Number.isFinite(n)?n:null};
function toggle(title,note,on){const input=el('input',{type:'checkbox',class:'switch',checked:on,attrs:{role:'switch'}});
  return {el:el('label',{class:'toggle'},el('span',{class:'grow'},el('strong',{text:title}),el('small',{text:note})),input),input}}
