// The one chat composer: a rounded container holding attachment previews, a frameless message field that grows up to a
// limit and then scrolls, and an action row (attach on the left; dictation and a round Send on the right). The container
// shows focus for the field inside it. Dictation uses the browser's own speech recognition and is hidden without it.
import {el,icon,iconButton,toast} from './core.js';
import {dictation} from './dictation.js';

/** options: {label, placeholder, value, maxLength, maxHeight, onSend(), onInput(), onAttach() (omit for no attach button),
 * attachLabel}. Returns {root, input, fit(), busy(on), clear(), files(nodes, note), focus(), stop()}. */
export function composer(o){
  const input=el('textarea',{class:'composer-input',rows:1,maxLength:o.maxLength||8000,placeholder:o.placeholder||'',value:o.value||'',
    attrs:{'aria-label':o.label||o.placeholder||'Message',enterkeyhint:'send'}});
  const strip=el('div',{class:'composer-files',hidden:true,attrs:{role:'group','aria-label':'Attachments'}});
  const note=el('p',{class:'composer-note',hidden:true,attrs:{role:'status'}});
  const max=o.maxHeight||160;let sending=false,base='';
  const fit=()=>{input.style.height='auto';const h=input.scrollHeight;input.style.height=Math.min(h,max)+'px';input.style.overflowY=h>max?'auto':'hidden'};
  input.addEventListener('input',()=>{fit();o.onInput?.()});
  // Enter sends with a keyboard and a fine pointer; Shift+Enter, and Enter on a touch keyboard, start a new line.
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&matchMedia('(pointer:fine)').matches){e.preventDefault();submit()}});
  const join=(a,b)=>b?(a&&!/\s$/.test(a)?a+' ':a)+b:a;
  const voice=dictation({
    words:(done,heard)=>{if(done)base=join(base,done);input.value=join(base,heard);fit();o.onInput?.()},
    state:(on,local)=>{mic.classList.toggle('on',on);mic.replaceChildren(icon(on?'stop':'voice'));const l=on?'Finish dictation':'Dictate message';
      mic.setAttribute('aria-label',l);mic.title=l;mic.setAttribute('aria-pressed',String(on));
      note.hidden=!on;note.textContent=local?'Listening on this device…':'Listening · your browser’s speech service writes it down'},
    problem:e=>toast(e==='not-allowed'||e==='service-not-allowed'?'Allow the microphone to dictate.':e==='network'?'Dictation needs a connection.':e==='language-not-supported'?'Dictation isn’t available for your language here.':'Dictation stopped.')});
  const mic=iconButton('voice','Dictate message',()=>{if(!voice||sending)return;if(!voice.listening)base=input.value;voice.toggle()},'composer-tool');
  mic.setAttribute('aria-pressed','false');if(!voice)mic.hidden=true;
  const attach=o.onAttach?iconButton('plus',o.attachLabel||'Attach',()=>{if(!sending)o.onAttach()},'composer-tool'):null;
  const send=iconButton('send','Send',submit,'composer-send');
  // Send while dictating finishes the dictation first, so nothing heard is lost.
  function submit(){if(voice?.listening){voice.stop();return}if(!sending)o.onSend()}
  const root=el('div',{class:'composer'},strip,input,note,el('div',{class:'composer-actions'},attach,el('span',{class:'grow'}),mic,send));
  // A tap on the container's empty space focuses the field, as in a single text box.
  root.addEventListener('pointerdown',e=>{if(e.target===root||e.target.classList.contains('composer-actions')||e.target.classList.contains('grow')){e.preventDefault();input.focus()}});
  requestAnimationFrame(fit);
  return {root,input,fit,
    busy(on){sending=on;send.disabled=on;if(attach)attach.disabled=on;mic.disabled=on;input.readOnly=on;send.setAttribute('aria-label',on?'Sending…':'Send');send.title=on?'Sending…':'Send';root.classList.toggle('busy',on)},
    clear(){input.value='';fit()},
    /** Attachment previews inside the container, with an optional one-line note. */
    files(nodes,text){strip.replaceChildren(...nodes,text?el('p',{class:'composer-files-note',text}):null);strip.hidden=!nodes.length},
    focus(){input.focus({preventScroll:true})},
    stop(){voice?.abort()}};
}
/** A photo preview for the composer's attachment strip, with a remove button. */
export function preview(image,label,remove){
  return el('div',{class:'composer-file'},image,iconButton('x',label,remove,'composer-file-x'));
}
