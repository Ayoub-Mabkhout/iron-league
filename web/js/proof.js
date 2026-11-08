// Capture a fresh camera frame. No file picker or gallery path is exposed here.
import {el,button,page} from './core.js';
import {api,ApiError} from './api.js';

const MAX_BASE64=Math.floor(1024*1024/3)*4;
export async function required(){
  try{return (await api('workout-proof-policy')).required===true}
  catch(error){if(error instanceof ApiError&&error.status===404)return false;throw error}
}

function jpeg(video){
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
  if(!video.videoWidth||!video.videoHeight||!context)throw new Error('The camera is still starting. Try again in a moment.');
  for(const size of [1080,800,600]){
    const ratio=Math.min(1,size/Math.max(video.videoWidth,video.videoHeight));
    canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));
    canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));
    context.drawImage(video,0,0,canvas.width,canvas.height);
    const data=canvas.toDataURL('image/jpeg',.8);
    const payload=data.split(',')[1];
    if(payload&&payload.length<=MAX_BASE64)return data;
  }
  throw new Error('Could not make a photo small enough. Try again.');
}

/** Returns a receipt only after the server accepts the workout and photo together. */
export function capture(submit,{canShare=false}={}){
  return new Promise(resolve=>{
    let stream=null,image='',sending=false,opening=false,submitted=false,receipt=null;
    const p=page('Workout photo',{cls:'workout-proof',onclose:close});
    const status=el('p',{class:'hint',attrs:{role:'status'}});
    const video=el('video',{class:'proof-image',autoplay:true,muted:true,playsInline:true,hidden:true,attrs:{'aria-label':'Live camera preview'}});
    const preview=el('img',{class:'proof-image',alt:'Your workout photo',hidden:true});
    const share=el('input',{type:'checkbox',class:'switch',checked:canShare});
    const shareRow=el('label',{class:'toggle',hidden:!canShare},el('span',{class:'grow'},el('strong',{text:'Post to Friends feed'}),
      el('small',{text:'Signed-in Iron League members can see this photo and workout details.'})),share);
    const open=button('Open camera','btn primary wide',start);
    const shoot=button('Take photo','btn primary wide',take);shoot.hidden=true;
    const retake=button('Retake','btn quiet wide',start);retake.hidden=true;
    const done=button('', 'btn primary wide',finish);done.hidden=true;
    const label=()=>done.textContent=share.checked?'Finish & post workout':'Finish privately';
    share.onchange=label;label();
    p.body.append(el('p',{class:'hint',text:'Take a photo of yourself training to finish this workout.'}),
      video,preview,shareRow,open,shoot,done,retake,status);

    function stop(){stream?.getTracks().forEach(track=>track.stop());stream=null;video.srcObject=null;video.hidden=true}
    function pause(){if(document.visibilityState==='hidden'&&stream){stop();shoot.hidden=true;open.hidden=false}}
    document.addEventListener('visibilitychange',pause);
    function close(){stop();document.removeEventListener('visibilitychange',pause);if(!sending)resolve(receipt)}
    async function start(){
      if(opening||sending)return;
      if(!navigator.mediaDevices?.getUserMedia){status.textContent='This browser cannot open the camera. Open Iron League in a browser with camera access.';return}
      opening=true;open.disabled=retake.disabled=true;status.textContent='Opening the camera…';
      try{
        const camera=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'user',width:{ideal:1280},height:{ideal:1280}}});
        if(p.closed||document.visibilityState==='hidden'){camera.getTracks().forEach(track=>track.stop());return}
        stream=camera;video.srcObject=stream;
        await video.play();
        if(p.closed||!stream)return;
        video.hidden=false;preview.hidden=true;open.hidden=true;shoot.hidden=false;done.hidden=retake.hidden=true;
        status.textContent='';
      }catch(error){
        stop();
        status.textContent=error.name==='NotAllowedError'?'Allow camera access for Iron League in your browser settings, then try again.':'Could not open the camera. Check it is available and try again.';
      }finally{opening=false;open.disabled=retake.disabled=false}
    }
    function take(){
      try{image=jpeg(video)}catch(error){status.textContent=error.message;return}
      stop();preview.src=image;preview.hidden=false;shoot.hidden=true;retake.hidden=done.hidden=false;
      status.textContent='Photo ready.';
    }
    async function finish(){
      if(sending||opening||!image)return;
      sending=submitted=done.disabled=retake.disabled=share.disabled=true;
      status.textContent='Finishing your workout…';
      try{
        receipt=await submit(image.split(',')[1],share.checked);
        if(!p.closed)p.close();else resolve(receipt);
      }catch(error){
        if(error instanceof ApiError&&[413,422].includes(error.status))submitted=false;
        status.textContent=error instanceof ApiError&&error.message?error.message:'Could not finish the workout. Check your connection and try again. Your workout is still here.';
      }finally{
        sending=done.disabled=false;
        retake.disabled=share.disabled=submitted;
        if(p.closed)resolve(receipt);
      }
    }
  });
}
