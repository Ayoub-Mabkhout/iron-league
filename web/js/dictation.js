// Dictation through the browser's own speech recognition (the Web Speech API), where the browser has one. Iron League
// sends the audio nowhere itself; the browser's engine does the listening, on the device when it offers that.
export const supported=()=>!!(globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition);

/** words(final,interim) receives each piece as it is heard; state(listening,onDevice) follows the microphone. */
export function dictation({words,state,problem}){
  const Kind=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition;
  if(!Kind)return null;
  let rec=null,listening=false,starting=false;
  async function start(){
    if(rec||starting)return;starting=true;
    const r=new Kind();r.lang=navigator.language||'en-US';
    r.interimResults=true;r.continuous=true;r.maxAlternatives=1;
    // Newer engines can listen on the device; prefer that whenever the language is installed.
    let local=false;
    try{if('processLocally' in r&&typeof Kind.available==='function'&&await Kind.available({langs:[r.lang],processLocally:true})==='available'){r.processLocally=true;local=true}}catch{}
    r.onresult=e=>{let done='',heard='';for(let i=e.resultIndex;i<e.results.length;i++){const x=e.results[i];if(x.isFinal)done+=x[0].transcript;else heard+=x[0].transcript}words(done.trim(),heard.trim())};
    r.onerror=e=>{if(e.error!=='no-speech'&&e.error!=='aborted')problem?.(e.error)};
    r.onend=()=>{if(rec!==r)return;rec=null;listening=false;words('','');state(false,local)};
    rec=r;starting=false;
    try{r.start();listening=true;state(true,local)}catch{rec=null;problem?.('start')}
  }
  return {get listening(){return listening||starting},toggle(){listening?rec?.stop():start()},stop(){rec?.stop()},abort(){const r=rec;rec=null;listening=false;r?.abort();if(r)state(false,false)}};
}
