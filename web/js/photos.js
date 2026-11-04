// Progress photos. With a password profile the bytes are encrypted on this device before they leave it, and the server
// keeps only ciphertext. A plaintext copy exists only while the owner shares one photo for a purpose: a single coach
// question (the server deletes it once the answer is written) or reminder notifications (until deselected).
// Older photos uploaded in plaintext are encrypted here after sign-in, and their plaintext originals are then deleted.
import {el,toast,choiceDialog,uid} from './core.js';
import * as store from './store.js';
import * as settings from './settings.js';
import {api,ApiError,photoUrl} from './api.js';
import {iso} from './live.js';
import * as auth from './auth.js';
import * as vault from './private-vault.js';

const MIMES=['image/jpeg','image/png','image/webp'];
const zone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const meta=id=>({kind:'photo',objectId:id,revision:1});
const opened=new Map();

/** The image type from its first bytes; the server checks the same signatures for shared copies. */
export function mime(bytes){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'image/jpeg';
  if(b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47&&b[4]===0x0d&&b[5]===0x0a&&b[6]===0x1a&&b[7]===0x0a)return 'image/png';
  if(String.fromCharCode(...b.subarray(0,4))==='RIFF'&&String.fromCharCode(...b.subarray(8,12))==='WEBP')return 'image/webp';
  return null;
}
const hex=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const encrypted=row=>row?.data?.vault===true;

/** Whether this profile has an encrypted vault on the server (unlocked or not). Answers false where the server has none. */
async function hasVault(){
  if(auth.vaultHandle())return true;
  try{await api('vault/key-envelope');return true}catch(e){if(e instanceof ApiError&&(e.status===404||e.status===401||e.status===403))return false;throw e}
}
/** The unlocked vault, asking for the password when this tab has not unlocked it yet. Null when declined. */
async function handle(){return auth.vaultHandle()||(await auth.unlockDialog()?auth.vaultHandle():null)}

/** Decrypted bytes of an encrypted photo, kept only in this tab's memory. */
async function bytesOf(row){
  const key=auth.vaultHandle();if(!key)throw new Error('locked');
  const {envelope}=await api('vault/records/photo/'+encodeURIComponent(row.id));
  return vault.open(key,meta(row.id),envelope);
}
function objectUrl(row){
  let p=opened.get(row.id);
  if(!p){p=bytesOf(row).then(b=>URL.createObjectURL(new Blob([b],{type:mime(b)||'application/octet-stream'})));opened.set(row.id,p);p.catch(()=>opened.delete(row.id))}
  return p;
}

/** An <img> for any photo row: the plaintext URL for an older photo, or the photo decrypted in memory. */
export function img(row,attrs={}){
  const image=el('img',{alt:'',decoding:'async',...attrs});
  if(!encrypted(row)){image.src=photoUrl(row.data.blob_id);return image}
  if(!auth.vaultHandle()){
    // Locked in this tab: the copy shared for reminders is still the owner's own, otherwise a placeholder.
    if(row.data.shared_blob_id)image.src=photoUrl(row.data.shared_blob_id);else{image.classList.add('locked');image.title='Unlock to see this photo'}
    return image;
  }
  image.classList.add('loading');
  objectUrl(row).then(url=>{image.src=url;image.classList.remove('loading')}).catch(()=>{image.classList.replace('loading','locked');image.title="Couldn't open this photo"});
  return image;
}
/** Whether some photos can't be shown until this tab unlocks the vault. */
export const locked=rows=>!auth.vaultHandle()&&rows.some(r=>encrypted(r)&&!r.data.shared_blob_id);
export async function unlock(){if(await auth.unlockDialog()){migrate();return true}return false}

/** Large photos are re-encoded to fit the 8 MiB limit. Encrypted when this profile has a vault, else the older plaintext upload. */
export async function upload(file,state='relaxed'){
  try{
    let blob=file;if(blob.size>7.5*1024*1024||!MIMES.includes(blob.type))blob=await shrink(file);
    const bytes=await blob.arrayBuffer(),id=uid();let entity;
    if(await hasVault()){
      const key=await handle();if(!key){toast('Unlock with your password to add photos.');return null}
      const envelope=await vault.seal(key,meta(id),bytes);
      await api('vault/records/photo/'+id,{method:'PUT',body:{base_revision:0,envelope}});
      entity={vault:true};
    }else{
      const hash=await hex(bytes);await api('photos/'+hash,{method:'PUT',body:bytes,raw:true,type:blob.type});entity={blob_id:hash};
    }
    const pose=['front','side','back','other'][await choiceDialog('Which pose?',['Front','Side','Back','Other'])??0];
    const sid=store.sprint()?.id,captured=file.lastModified&&Date.now()-file.lastModified<400*86400000?file.lastModified:Date.now();
    store.putEntity('photo',id,{captured_at:iso(captured,zone()),...entity,pose,state,...(sid?{sprint_id:sid}:{})});await store.sync();toast('Photo added');return id;
  }catch(e){toast(e.message==='offline'?'Connect to add photos.':e.message||"Couldn't add that photo");return null}
}
async function shrink(file){
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}),scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
  const c=new OffscreenCanvas(Math.round(bitmap.width*scale),Math.round(bitmap.height*scale));c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);
  return c.convertToBlob({type:'image/jpeg',quality:.88});
}

/** Writes one photo straight to the server, so the caller knows it took effect before relying on it. */
async function write(row,data){
  await store.sync();
  const result=(await api('sync',{body:{operations:[{mutation_id:uid(),kind:'photo',id:row.id,base_revision:store.revision('photo',row.id),deleted:false,data}]}})).results[0];
  await store.sync();return result;
}
const current=id=>{const data=store.data('photo',id);return data?{id,data}:null};

/** Uploads a plaintext copy of an encrypted photo for a purpose. Resolves true once the server holds it. */
export async function share(row){
  row=current(row.id)||row;
  if(!encrypted(row)||row.data.shared_blob_id)return true;
  if(!await handle())return false;
  const bytes=await bytesOf(row),type=mime(bytes);if(!type)throw new Error('Unsupported photo');
  const hash=await hex(bytes);
  await api('photos/'+hash,{method:'PUT',body:bytes,raw:true,type});
  await write(row,{...row.data,shared_blob_id:hash});return true;
}
/** Withdraws the shared copy; the server deletes its bytes when nothing else uses them. */
export async function unshare(row){
  row=current(row.id)||row;
  if(!encrypted(row)||!row.data.shared_blob_id)return;
  await write(row,{...row.data,shared_blob_id:null});
}
/** Shares newly chosen reminder photos before saving the choice, and withdraws deselected ones afterwards. */
export async function saveReminderPhotos(before,after,save){
  try{for(const id of after){const row=current(id);if(row&&!await share(row))return false}}
  catch{toast("Couldn't share those photos. Check your connection.");return false}
  const ok=await save();
  if(ok)for(const id of before)if(!after.includes(id)){const row=current(id);if(row)try{await unshare(row)}catch{}}
  return ok;
}

let migrating=null;
/** Encrypts older plaintext photos, one at a time. Safe to repeat: finished photos are skipped and an object already
 * stored from an interrupted run is checked and reused. The plaintext original goes once the entity changes, unless it
 * stays shared for reminders. */
export function migrate(){
  if(!migrating)migrating=run().finally(()=>{migrating=null});
  return migrating;
  async function run(){
    if(!auth.vaultHandle())return;
    await store.sync();
    const legacy=()=>store.rows('photo').filter(r=>!encrypted(r)&&r.data.blob_id);
    if(!legacy().length)return;
    await settings.load();const kept=new Set(settings.get().photo_ids||[]);
    toast('Encrypting your photos…');let failed=0;
    for(const row of legacy()){
      try{await encryptOne(row,kept.has(row.id))}catch(e){failed++;console.warn('Photo encryption stopped for',row.id,e)}
    }
    toast(failed?"Some photos couldn't be encrypted yet. Iron League will try again next time.":'Your photos are encrypted');
  }
}
async function encryptOne(row,forReminders){
  const key=auth.vaultHandle();if(!key)throw new Error('locked');
  const bytes=new Uint8Array(await (await api('photos/'+row.data.blob_id)).arrayBuffer());
  if(await hex(bytes)!==row.data.blob_id)throw new Error('Photo changed in transit');
  try{await api('vault/records/photo/'+encodeURIComponent(row.id),{method:'PUT',body:{base_revision:0,envelope:await vault.seal(key,meta(row.id),bytes)}})}
  catch(e){
    if(!(e instanceof ApiError&&e.status===409))throw e;
    // Stored by an earlier, interrupted run: reuse it only if it really is this photo.
    const {envelope,revision}=await api('vault/records/photo/'+encodeURIComponent(row.id));
    if(revision!==1||await hex(await vault.open(key,meta(row.id),envelope))!==row.data.blob_id)throw e;
  }
  const data={...row.data,vault:true,shared_blob_id:forReminders?row.data.blob_id:null};delete data.blob_id;
  await write(row,data);
}
