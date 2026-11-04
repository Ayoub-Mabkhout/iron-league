// Sunrise and sunset, ported from Android's DaylightTheme: light between local sunrise and sunset, dark otherwise. The place is
// estimated from the time zone (as the native Meridian does), so nothing asks for location. The default for new viewers.
const RAD=Math.PI/180,DAY=86400000,J1970=2440588,J2000=2451545,J0=0.0009,KEY='iron-theme';
export const MODES=[['sun','Sunrise & sunset'],['system','System'],['light','Light'],['dark','Dark']];

function cycle(at,lat,lon){
  const d=at/DAY-0.5+J1970-J2000,lw=-lon*RAD,phi=lat*RAD,n=Math.round(d-J0-lw/(2*Math.PI));
  const ds=J0+lw/(2*Math.PI)+n,m=RAD*(357.5291+0.98560028*ds),c=RAD*(1.9148*Math.sin(m)+0.02*Math.sin(2*m)+0.0003*Math.sin(3*m));
  const l=m+c+RAD*102.9372+Math.PI,dec=Math.asin(Math.sin(l)*Math.sin(RAD*23.4397)),transit=J2000+ds+0.0053*Math.sin(m)-0.0069*Math.sin(2*l);
  const cosW=(Math.sin(-0.833*RAD)-Math.sin(phi)*Math.sin(dec))/(Math.cos(phi)*Math.cos(dec));
  if(cosW>=1)return {times:null,light:false};if(cosW<=-1)return {times:null,light:true};
  const set=J2000+J0+(Math.acos(cosW)+lw)/(2*Math.PI)+n+0.0053*Math.sin(m)-0.0069*Math.sin(2*l),rise=transit-(set-transit);
  return {times:[Math.round((rise+0.5-J1970)*DAY),Math.round((set+0.5-J1970)*DAY)]};
}
/** Dark outside the daylight of the nearest solar cycles; polar days and nights follow the sun's state. */
export function dark(at,lat,lon){
  for(let o=-1;o<=1;o++){const t=cycle(at+o*DAY,lat,lon).times;if(t&&at>=t[0]&&at<t[1])return false}
  const today=cycle(at,lat,lon);return today.times?true:!today.light;
}
export function nextChange(at,lat,lon){
  let next=Infinity;for(let o=-1;o<=2;o++){const t=cycle(at+o*DAY,lat,lon).times;if(t)for(const e of t)if(e>at&&e<next&&dark(e-1,lat,lon)!==dark(e,lat,lon))next=e}
  return next===Infinity?at+3600000:next;
}
/** A rough place from the time zone: standard offset for longitude, the region for latitude. */
export function zonePlace(zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'',now=new Date()){
  const y=now.getFullYear(),standard=-Math.max(new Date(y,0,1).getTimezoneOffset(),new Date(y,6,1).getTimezoneOffset())/60;
  const lon=Math.max(-180,Math.min(180,standard*15)),z=zone;
  const lat=z.startsWith('Europe/')?48:z.startsWith('America/')?(/Argentina|Sao_Paulo|Santiago|Lima/.test(z)?-20:38):z.startsWith('Asia/')?30:z.startsWith('Africa/')?5:z.startsWith('Australia/')?-30:z.startsWith('Pacific/')?-15:z.startsWith('Antarctica/')?-75:45;
  return [lat,lon];
}

export const mode=()=>{try{const m=localStorage.getItem(KEY);return MODES.some(x=>x[0]===m)?m:'sun'}catch{return 'sun'}};
export function setMode(m){try{localStorage.setItem(KEY,m)}catch{}apply()}
let timer=0;const listeners=new Set();
/** Paints the chosen theme and schedules the next sunrise or sunset while the page is open. */
export function apply(){
  clearTimeout(timer);const m=mode(),root=document.documentElement,before=root.dataset.theme||'';
  if(m==='sun'){const [lat,lon]=zonePlace(),now=Date.now();root.dataset.theme=dark(now,lat,lon)?'dark':'light';timer=setTimeout(apply,Math.min(nextChange(now,lat,lon)-now+1000,2**31-1))}
  else if(m==='system')delete root.dataset.theme;else root.dataset.theme=m;
  const isDark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme:dark)').matches;
  for(const meta of document.querySelectorAll('meta[name=theme-color]'))meta.content=isDark?'#130E1C':'#FAF5EC';
  if((root.dataset.theme||'')!==before)for(const f of listeners)f();
}
/** Drawn art that bakes in theme colours repaints through this. */
export const onChange=f=>listeners.add(f);
export function start(){apply();addEventListener('visibilitychange',()=>{if(!document.hidden)apply()});matchMedia('(prefers-color-scheme:dark)').addEventListener?.('change',apply)}
