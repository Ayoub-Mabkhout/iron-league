// Chat answers as rich Markdown: headings, emphasis, code, lists, quotes, tables and links. Built from DOM nodes, never
// innerHTML, so an answer can't inject markup. Half-written text (a streaming answer) renders without losing anything.
import {el} from './core.js';

const SAFE=/^(https?:|mailto:)/i;
/** One answer as a fragment of block elements, ready to drop into a bubble. */
export function markdown(text){
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),out=document.createDocumentFragment();let i=0;
  const blank=l=>!l.trim(),fence=l=>/^\s*(```|~~~)/.test(l),rule=l=>/^\s*([-*_])(\s*\1){2,}\s*$/.test(l),heading=l=>/^\s{0,3}#{1,6}\s/.test(l);
  const item=l=>/^\s*([-*+]|\d{1,3}[.)])\s+/.exec(l),quote=l=>/^\s{0,3}>/.test(l),row=l=>/^\s*\|.*\|\s*$/.test(l),divider=l=>/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while(i<lines.length){
    const l=lines[i];
    if(blank(l)){i++;continue}
    if(fence(l)){const mark=l.trim().slice(0,3),lang=l.trim().slice(3).trim(),code=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(mark))code.push(lines[i++]);i++;
      out.append(el('pre',{class:'md-code',attrs:lang?{'data-lang':lang}:{}},el('code',{text:code.join('\n')})));continue}
    if(heading(l)){const m=/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);out.append(el('h'+Math.min(6,m[1].length+2),{class:'md-h'},...inline(m[2])));i++;continue}
    if(rule(l)){out.append(el('hr',{class:'md-rule'}));i++;continue}
    if(quote(l)){const q=[];while(i<lines.length&&(quote(lines[i])||!blank(lines[i])&&q.length&&!item(lines[i])&&!fence(lines[i])))q.push(lines[i++].replace(/^\s{0,3}>\s?/,''));
      const b=el('blockquote',{class:'md-quote'});b.append(markdown(q.join('\n')));out.append(b);continue}
    if(row(l)&&i+1<lines.length&&divider(lines[i+1])){const cells=r=>r.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
      const head=cells(l),body=[];i+=2;while(i<lines.length&&row(lines[i]))body.push(cells(lines[i++]));
      out.append(el('div',{class:'md-table'},el('table',{},el('thead',{},el('tr',{},...head.map(c=>el('th',{},...inline(c))))),el('tbody',{},...body.map(r=>el('tr',{},...head.map((_,k)=>el('td',{},...inline(r[k]||'')))))))));continue}
    if(item(l)){out.append(list(lines,i,n=>i=n));continue}
    const para=[];while(i<lines.length&&!blank(lines[i])&&!fence(lines[i])&&!heading(lines[i])&&!quote(lines[i])&&!item(lines[i])&&!(para.length&&rule(lines[i]))&&!(row(lines[i])&&divider(lines[i+1]||'')))para.push(lines[i++]);
    const p=el('p',{});para.forEach((x,k)=>{if(k)p.append(/ {2,}$|\\$/.test(para[k-1])?el('br'):' ');p.append(...inline(x.replace(/ {2,}$|\\$/,'').trim()))});out.append(p);
  }
  return out;
}

/** A list and anything nested deeper under it; `done` receives the line after the list. */
function list(lines,start,done){
  const first=/^(\s*)([-*+]|(\d{1,3})[.)])\s+/.exec(lines[start]),indent=first[1].length,ordered=!!first[3];
  const root=el(ordered?'ol':'ul',{class:'md-list'});if(ordered&&first[3]!=='1')root.start=+first[3];let i=start,li=null;
  while(i<lines.length){
    const l=lines[i],m=/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(l);
    if(m&&m[1].length<=indent+1&&m[1].length>=indent){if(/\d/.test(m[2])!==ordered)break;li=el('li',{},...task(m[3]));root.append(li);i++;continue}
    if(m&&m[1].length>indent&&li){li.append(list(lines,i,n=>i=n));continue}
    if(!l.trim()){const next=lines[i+1]||'';if(/^\s+\S/.test(next)&&li&&!(/^\s*([-*+]|\d{1,3}[.)])\s+/.test(next)&&next.search(/\S/)<=indent)){i++;continue}break}
    if(li&&/^\s+\S/.test(l)&&!m){li.append(' ',...inline(l.trim()));i++;continue}
    if(li&&!m&&!/^\s*(#|>|```|~~~|\|)/.test(l)&&i>start&&lines[i-1].trim()){li.append(' ',...inline(l.trim()));i++;continue}
    break;
  }
  done(i);return root;
}
function task(text){const m=/^\[([ xX])\]\s+(.*)$/.exec(text);if(!m)return inline(text);const box=el('span',{class:'md-check'+(m[1]===' '?'':' done'),text:m[1]===' '?'○':'✓',attrs:{'aria-hidden':'true'}});return [box,...inline(m[2])]}

/** Inline spans: code first so nothing inside it is read as Markdown, then links, then emphasis. */
export function inline(text){
  const out=[];let s=String(text||''),buf='';
  const flush=()=>{if(buf){out.push(...autolink(buf));buf=''}};
  for(let i=0;i<s.length;){
    const c=s[i],rest=s.slice(i);
    if(c==='\\'&&i+1<s.length&&/[\\`*_{}\[\]()#+\-.!|>~]/.test(s[i+1])){buf+=s[i+1];i+=2;continue}
    if(c==='`'){const run=/^`+/.exec(rest)[0],end=s.indexOf(run,i+run.length);if(end>0){flush();out.push(el('code',{class:'md-inline',text:s.slice(i+run.length,end).trim()}));i=end+run.length;continue}}
    if(c==='['){const m=/^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);if(m){flush();out.push(SAFE.test(m[2])?el('a',{href:m[2],target:'_blank',rel:'noopener noreferrer'},...inline(m[1]||m[2])):el('span',{},...inline(m[1])));i+=m[0].length;continue}}
    const em=/^(\*\*\*|___|\*\*|__|~~|\*|_)/.exec(rest);
    if(em&&!(em[1][0]==='_'&&/\w/.test(s[i-1]||''))){const mark=em[1],from=i+mark.length;let end=s.indexOf(mark,from);
      while(end>0&&(s[end-1]===' '||(mark.length===1&&s[end+1]===mark)))end=s.indexOf(mark,end+(s[end+1]===mark?2:1));
      if(end>from&&s[from]!==' '){flush();const inner=inline(s.slice(from,end));
        out.push(mark.length===3?el('strong',{},el('em',{},...inner)):mark==='~~'?el('s',{},...inner):mark.length===2?el('strong',{},...inner):el('em',{},...inner));i=end+mark.length;continue}}
    buf+=c;i++;
  }
  flush();return out;
}
function autolink(text){const out=[];let last=0;for(const m of text.matchAll(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g)){out.push(text.slice(last,m.index),el('a',{href:m[0],target:'_blank',rel:'noopener noreferrer',text:m[0]}));last=m.index+m[0].length}out.push(text.slice(last));return out.filter(x=>x!=='')}
