/** Client-held vault keys. No network or persistent-storage access belongs in this module.
 *
 * Server-safe values: public password parameters, authSecret and encrypted record/envelopes.
 * Keep password, recoveryKey and the opaque vault handle in the client. Only authSecret
 * is an authentication credential; it cannot derive the encryption key.
 * Passkeys: a WebAuthn PRF output (32 bytes, released by the authenticator only after user
 * verification) derives a passkey auth secret and, under a separate label, a KEK bound to
 * userId/keyId/credentialId that wraps the same master key. The PRF output never leaves the client.
 * WebCrypto contract: https://www.w3.org/TR/webcrypto-1/
 */
export const VERSION=1;
export const KDF_VERSION='pbkdf2sha256_600k_hkdfsha256_v1';
export const ITERATIONS=600000;
export const MAX_PLAINTEXT_BYTES=16*1024*1024;
export const MAX_PASSKEYS=10;

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const keys=new WeakMap(),TAG_BYTES=16,NONCE_BYTES=12,SALT_BYTES=16,KEY_BYTES=32;
const AUTH_DOMAIN='iron-league/auth/v1';
const PASSWORD_DOMAIN='iron-league/private-vault/password-kek/v1';
const RECOVERY_DOMAIN='iron-league/private-vault/recovery-kek/v1';
const RECOVERY_AUTH_DOMAIN='iron-league/recovery-auth/v1';
const AAD_DOMAIN='iron-league/private-vault/object/v1';
const PRF_DOMAIN='iron-league/passkey-prf/v1';
const PASSKEY_AUTH_DOMAIN='iron-league/passkey-auth/v1';
const PASSKEY_DOMAIN='iron-league/private-vault/passkey-kek/v1';
const CREDENTIAL_ID=/^[A-Za-z0-9_-]{16,1024}$/;
const USER_ID=/^[A-Za-z0-9_-]{1,128}$/,KIND=/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/,OBJECT_ID=/^[A-Za-z0-9_.:-]{1,200}$/;

export class VaultError extends Error {constructor(message){super(message);this.name='VaultError'}}

function cryptoApi(){if(!globalThis.crypto?.subtle)throw new VaultError('WebCrypto requires a secure browser connection');return globalThis.crypto}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function random(size){return cryptoApi().getRandomValues(new Uint8Array(size))}
function base64url(bytes){const parts=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));return btoa(parts.join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function unbase64url(text,{length,min=0,max=MAX_PLAINTEXT_BYTES+TAG_BYTES}={}){
  const cap=length??max;
  if(typeof text!=='string'||text.length>Math.ceil(cap*4/3)||!/^[A-Za-z0-9_-]*$/.test(text)||text.length%4===1)throw new VaultError('Invalid vault encoding');
  let binary;try{binary=atob(text.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-text.length%4)%4))}catch{throw new VaultError('Invalid vault encoding')}
  if((length!==undefined&&binary.length!==length)||binary.length<min||binary.length>max)throw new VaultError('Invalid vault length');
  const out=Uint8Array.from(binary,c=>c.charCodeAt(0));if(base64url(out)!==text){out.fill(0);throw new VaultError('Noncanonical vault encoding')}return out;
}

/** Parameters can be returned before login: the authentication derivation is independent of userId. */
export function passwordParameters(){return {version:KDF_VERSION,kdf:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:base64url(random(SALT_BYTES))}}
function parameters(value){
  if(!object(value)||value.version!==KDF_VERSION||value.kdf!=='PBKDF2'||value.hash!=='SHA-256'||value.iterations!==ITERATIONS)throw new VaultError('Unsupported password parameters');
  unbase64url(value.salt,{length:SALT_BYTES});
  return {version:KDF_VERSION,kdf:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:value.salt};
}
function identity(userId,keyId){if(typeof userId!=='string'||!USER_ID.test(userId))throw new VaultError('Invalid vault user');unbase64url(keyId,{length:16})}
function metadata(userId,keyId,meta){
  identity(userId,keyId);
  if(!object(meta)||typeof meta.kind!=='string'||!KIND.test(meta.kind)||typeof meta.objectId!=='string'||!OBJECT_ID.test(meta.objectId)||!Number.isSafeInteger(meta.revision)||meta.revision<0)throw new VaultError('Invalid private-object identity');
  if((meta.version!==undefined&&meta.version!==VERSION)||(meta.userId!==undefined&&meta.userId!==userId)||(meta.keyId!==undefined&&meta.keyId!==keyId))throw new VaultError('Private-object identity does not match the vault');
  return {version:VERSION,userId,keyId,kind:meta.kind,objectId:meta.objectId,revision:meta.revision};
}
function aad(meta){return encoder.encode(JSON.stringify([AAD_DOMAIN,meta.version,meta.userId,meta.keyId,meta.kind,meta.objectId,meta.revision]))}
function envelope(expected,value,max=MAX_PLAINTEXT_BYTES+TAG_BYTES){
  if(!object(value))throw new VaultError('Invalid private envelope');
  for(const key of ['version','userId','keyId','kind','objectId','revision'])if(value[key]!==expected[key])throw new VaultError('Private-object identity does not match the envelope');
  return {nonce:unbase64url(value.nonceB64,{length:NONCE_BYTES}),cipher:unbase64url(value.cipherB64,{min:TAG_BYTES,max})};
}
function bytes(value){
  const size=typeof value==='string'?value.length:ArrayBuffer.isView(value)||value instanceof ArrayBuffer?value.byteLength:0;
  if(size>MAX_PLAINTEXT_BYTES)throw new VaultError('Private object is too large');
  let result;if(typeof value==='string')result=encoder.encode(value);else if(value instanceof ArrayBuffer)result=new Uint8Array(value).slice();
  else if(ArrayBuffer.isView(value))result=new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice();else throw new VaultError('Private data must be text or bytes');
  if(result.length>MAX_PLAINTEXT_BYTES){result.fill(0);throw new VaultError('Private object is too large')}return result;
}
async function passwordBase(password,params){
  if(typeof password!=='string'||password.length<1||password.length>1024)throw new VaultError('A password of 1 to 1024 characters is required');
  const source=encoder.encode(password),salt=unbase64url(params.salt,{length:SALT_BYTES});let derived;
  try{const key=await cryptoApi().subtle.importKey('raw',source,'PBKDF2',false,['deriveBits']);
    derived=new Uint8Array(await cryptoApi().subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt},key,256));
    return await cryptoApi().subtle.importKey('raw',derived,'HKDF',false,['deriveBits','deriveKey']);
  }finally{source.fill(0);derived?.fill(0)}
}
function hkdf(base,salt,info){return {name:'HKDF',hash:'SHA-256',salt,info:encoder.encode(info)}}
async function authFrom(base,params){
  const raw=new Uint8Array(await cryptoApi().subtle.deriveBits(hkdf(base,unbase64url(params.salt,{length:SALT_BYTES}),AUTH_DOMAIN),base,256));
  try{return base64url(raw)}finally{raw.fill(0)}
}
async function passwordKeys(password,params,userId,keyId){
  const base=await passwordBase(password,params);
  const key=await cryptoApi().subtle.deriveKey(hkdf(base,unbase64url(params.salt,{length:SALT_BYTES}),JSON.stringify([PASSWORD_DOMAIN,userId,keyId])),base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  return {key,authSecret:await authFrom(base,params)};
}
async function recoveryKek(recoveryKey,salt,userId,keyId){
  const raw=unbase64url(recoveryKey,{length:KEY_BYTES});
  try{const base=await cryptoApi().subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
    return await cryptoApi().subtle.deriveKey(hkdf(base,unbase64url(salt,{length:SALT_BYTES}),JSON.stringify([RECOVERY_DOMAIN,userId,keyId])),base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }finally{raw.fill(0)}
}
async function encrypt(key,meta,plain){
  const nonce=random(NONCE_BYTES),cipher=new Uint8Array(await cryptoApi().subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(meta),tagLength:128},key,plain));
  return {...meta,nonceB64:base64url(nonce),cipherB64:base64url(cipher)};
}
async function decrypt(key,expected,value,max){
  const data=envelope(expected,value,max);
  try{return new Uint8Array(await cryptoApi().subtle.decrypt({name:'AES-GCM',iv:data.nonce,additionalData:aad(expected),tagLength:128},key,data.cipher))}
  catch{throw new VaultError('Private data authentication failed')}
}
function wrapperMeta(record,kind,revision){return metadata(record.userId,record.keyId,{kind,objectId:record.keyId,revision})}
function credential(value){
  if(typeof value!=='string'||!CREDENTIAL_ID.test(value))throw new VaultError('Invalid passkey identifier');
  unbase64url(value,{min:1,max:1024});return value;
}
function validateRecord(record){
  if(!object(record)||record.version!==VERSION||!object(record.password)||!object(record.recovery))throw new VaultError('Unsupported vault record');
  identity(record.userId,record.keyId);parameters(record.password.parameters);unbase64url(record.recovery.salt,{length:SALT_BYTES});
  const password=record.password.wrappedMaster,recovery=record.recovery.wrappedMaster;
  if(!object(password)||!Number.isSafeInteger(password.revision)||password.revision<1)throw new VaultError('Invalid password wrapper');
  envelope(wrapperMeta(record,'vault-password-key',password.revision),password,KEY_BYTES+TAG_BYTES);
  envelope(wrapperMeta(record,'vault-recovery-key',1),recovery,KEY_BYTES+TAG_BYTES);
  if(record.passkeys!==undefined){
    if(!Array.isArray(record.passkeys)||record.passkeys.length>MAX_PASSKEYS)throw new VaultError('Invalid passkey wrappers');
    const seen=new Set();
    for(const item of record.passkeys){
      if(!object(item)||seen.has(credential(item.credentialId)))throw new VaultError('Invalid passkey wrapper');seen.add(item.credentialId);
      envelope(wrapperMeta(record,'vault-passkey-key',1),item.wrappedMaster,KEY_BYTES+TAG_BYTES);
    }
  }
  return record;
}
const passkeysOf=record=>record.passkeys===undefined?{}:{passkeys:JSON.parse(JSON.stringify(record.passkeys))};
function handle(record,key){const vault=Object.freeze({version:VERSION,userId:record.userId,keyId:record.keyId});keys.set(vault,key);return vault}
function master(vault){const key=keys.get(vault);if(!key)throw new VaultError('The private vault is locked');return key}
async function wrapMaster(key,kek,meta){const raw=new Uint8Array(await cryptoApi().subtle.exportKey('raw',key));try{return await encrypt(kek,meta,raw)}finally{raw.fill(0)}}
async function unwrapMaster(kek,meta,wrapped){const raw=await decrypt(kek,meta,wrapped,KEY_BYTES+TAG_BYTES);try{if(raw.length!==KEY_BYTES)throw new VaultError('Invalid master key');return await cryptoApi().subtle.importKey('raw',raw,{name:'AES-GCM'},true,['encrypt','decrypt'])}finally{raw.fill(0)}}

/** Derive the only password-derived value allowed to leave the client (43-character base64url). */
export async function deriveAuthSecret(password,params){const p=parameters(params);return authFrom(await passwordBase(password,p),p)}
export const authSecret=deriveAuthSecret;

/** The PRF input for every Iron League passkey: the browser further hashes it per relying party. */
export async function passkeyPrfSalt(){return new Uint8Array(await cryptoApi().subtle.digest('SHA-256',encoder.encode(PRF_DOMAIN)))}
async function prfBase(prfOutput){
  const view=prfOutput instanceof ArrayBuffer?new Uint8Array(prfOutput):ArrayBuffer.isView(prfOutput)?new Uint8Array(prfOutput.buffer,prfOutput.byteOffset,prfOutput.byteLength):null;
  if(!view||view.length!==KEY_BYTES)throw new VaultError('A 32-byte passkey PRF output is required');
  const raw=view.slice();try{return await cryptoApi().subtle.importKey('raw',raw,'HKDF',false,['deriveBits','deriveKey'])}finally{raw.fill(0)}
}
/** The only passkey-derived value allowed to leave the client (43-character base64url). Independent of userId, so a
 * discoverable sign-in can send it before the profile is known. */
export async function derivePasskeyAuthSecret(prfOutput){
  const raw=new Uint8Array(await cryptoApi().subtle.deriveBits(hkdf(null,new Uint8Array(0),PASSKEY_AUTH_DOMAIN),await prfBase(prfOutput),256));
  try{return base64url(raw)}finally{raw.fill(0)}
}
async function passkeyKek(prfOutput,userId,keyId,credentialId){
  return cryptoApi().subtle.deriveKey(hkdf(null,new Uint8Array(0),JSON.stringify([PASSKEY_DOMAIN,userId,keyId,credentialId])),await prfBase(prfOutput),{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

/** Separate recovery-authentication proof. The raw recovery key and recovery KEK stay client-held. */
export async function deriveRecoveryAuthSecret(recoveryKey,salt){
  const saltBytes=unbase64url(salt,{length:SALT_BYTES}),raw=unbase64url(recoveryKey,{length:KEY_BYTES});let proof;
  try{const base=await cryptoApi().subtle.importKey('raw',raw,'HKDF',false,['deriveBits']);
    proof=new Uint8Array(await cryptoApi().subtle.deriveBits(hkdf(base,saltBytes,RECOVERY_AUTH_DOMAIN),base,256));return base64url(proof);
  }finally{raw.fill(0);proof?.fill(0)}
}

/** Returns a server-safe record and authSecret, plus client-only vault and recoveryKey. */
export async function enroll(password,userId,params=passwordParameters()){
  const p=parameters(params),keyId=base64url(random(16));identity(userId,keyId);
  const derived=await passwordKeys(password,p,userId,keyId),key=await cryptoApi().subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const rawRecovery=random(KEY_BYTES);let recoveryKey;try{recoveryKey=base64url(rawRecovery)}finally{rawRecovery.fill(0)}
  const record={version:VERSION,userId,keyId,password:{parameters:p},recovery:{salt:base64url(random(SALT_BYTES))}};
  record.password.wrappedMaster=await wrapMaster(key,derived.key,wrapperMeta(record,'vault-password-key',1));
  const recovery=await recoveryKek(recoveryKey,record.recovery.salt,userId,keyId);
  record.recovery.wrappedMaster=await wrapMaster(key,recovery,wrapperMeta(record,'vault-recovery-key',1));
  return {vault:handle(record,key),record,authSecret:derived.authSecret,recoveryKey,recoveryAuthSecret:await deriveRecoveryAuthSecret(recoveryKey,record.recovery.salt)};
}
export async function unlock(password,record){
  validateRecord(record);const derived=await passwordKeys(password,record.password.parameters,record.userId,record.keyId);
  const key=await unwrapMaster(derived.key,wrapperMeta(record,'vault-password-key',record.password.wrappedMaster.revision),record.password.wrappedMaster);
  return {vault:handle(record,key),authSecret:derived.authSecret};
}
/** Each object requires its expected identity; never take the expected revision from untrusted ciphertext. */
export async function seal(vault,meta,plaintext){const key=master(vault),bound=metadata(vault.userId,vault.keyId,meta),plain=bytes(plaintext);try{return await encrypt(key,bound,plain)}finally{plain.fill(0)}}
export async function open(vault,expectedMeta,value){return decrypt(master(vault),metadata(vault.userId,vault.keyId,expectedMeta),value,MAX_PLAINTEXT_BYTES+TAG_BYTES)}
export async function sealJSON(vault,meta,value){return seal(vault,meta,JSON.stringify(value))}
export async function openJSON(vault,meta,value){const plain=await open(vault,meta,value);try{return JSON.parse(decoder.decode(plain))}catch{throw new VaultError('Private object is not valid JSON')}finally{plain.fill(0)}}

/** Password rotation wraps the same master key; existing objects, the recovery wrapper and passkeys remain valid. */
export async function changePassword(vault,record,newPassword,params=passwordParameters()){
  validateRecord(record);const key=master(vault);
  if(vault.userId!==record.userId||vault.keyId!==record.keyId)throw new VaultError('Vault record does not match the unlocked vault');
  const p=parameters(params),derived=await passwordKeys(newPassword,p,record.userId,record.keyId),revision=record.password.wrappedMaster.revision+1;
  const next={version:VERSION,userId:record.userId,keyId:record.keyId,password:{parameters:p},recovery:JSON.parse(JSON.stringify(record.recovery)),...passkeysOf(record)};
  next.password.wrappedMaster=await wrapMaster(key,derived.key,wrapperMeta(next,'vault-password-key',revision));
  return {record:next,authSecret:derived.authSecret};
}

/** Explicit recovery-key rotation. Replace the server's recovery-auth proof together with this record. */
export async function rotateRecoveryKey(vault,record){
  validateRecord(record);const key=master(vault);
  if(vault.userId!==record.userId||vault.keyId!==record.keyId)throw new VaultError('Vault record does not match the unlocked vault');
  const raw=random(KEY_BYTES);let recoveryKey;try{recoveryKey=base64url(raw)}finally{raw.fill(0)}
  const next={version:VERSION,userId:record.userId,keyId:record.keyId,password:JSON.parse(JSON.stringify(record.password)),recovery:{salt:base64url(random(SALT_BYTES))},...passkeysOf(record)};
  next.recovery.wrappedMaster=await wrapMaster(key,await recoveryKek(recoveryKey,next.recovery.salt,next.userId,next.keyId),wrapperMeta(next,'vault-recovery-key',1));
  return {record:next,recoveryKey,recoveryAuthSecret:await deriveRecoveryAuthSecret(recoveryKey,next.recovery.salt)};
}
/** Local key recovery only. A server authentication reset needs its separate proof/authorization flow. */
export async function recover(recoveryKey,record,newPassword,params=passwordParameters(),options={}){
  validateRecord(record);const kek=await recoveryKek(recoveryKey,record.recovery.salt,record.userId,record.keyId);
  const key=await unwrapMaster(kek,wrapperMeta(record,'vault-recovery-key',1),record.recovery.wrappedMaster),vault=handle(record,key);
  try{const changed=await changePassword(vault,record,newPassword,params);
    if(options.rotateRecovery===true)return {vault,authSecret:changed.authSecret,...await rotateRecoveryKey(vault,changed.record)};
    return {vault,...changed,recoveryAuthSecret:await deriveRecoveryAuthSecret(recoveryKey,record.recovery.salt)};
  }catch(error){destroy(vault);throw error}
}
/** Adds a passkey's copy of the master key. Store the record first, then register the returned authSecret with the
 * server; the PRF output itself stays here. */
export async function addPasskey(vault,record,credentialId,prfOutput){
  validateRecord(record);const key=master(vault);credential(credentialId);
  if(vault.userId!==record.userId||vault.keyId!==record.keyId)throw new VaultError('Vault record does not match the unlocked vault');
  const existing=record.passkeys||[];
  if(existing.some(item=>item.credentialId===credentialId))throw new VaultError('This passkey is already added');
  if(existing.length>=MAX_PASSKEYS)throw new VaultError('Remove a passkey before adding another');
  const next={version:VERSION,userId:record.userId,keyId:record.keyId,password:JSON.parse(JSON.stringify(record.password)),recovery:JSON.parse(JSON.stringify(record.recovery))};
  const wrappedMaster=await wrapMaster(key,await passkeyKek(prfOutput,record.userId,record.keyId,credentialId),wrapperMeta(next,'vault-passkey-key',1));
  next.passkeys=[...JSON.parse(JSON.stringify(existing)),{credentialId,wrappedMaster}];
  return {record:next,authSecret:await derivePasskeyAuthSecret(prfOutput)};
}
/** Opens the vault with a passkey's PRF output. Fails like a wrong password when this passkey has no wrapper. */
export async function unlockWithPasskey(record,credentialId,prfOutput){
  validateRecord(record);credential(credentialId);
  const item=(record.passkeys||[]).find(entry=>entry.credentialId===credentialId);
  if(!item)throw new VaultError('This passkey cannot open the private vault');
  const kek=await passkeyKek(prfOutput,record.userId,record.keyId,credentialId);
  const key=await unwrapMaster(kek,wrapperMeta(record,'vault-passkey-key',1),item.wrappedMaster);
  return {vault:handle(record,key),authSecret:await derivePasskeyAuthSecret(prfOutput)};
}
/** The record without this passkey's wrapper (or the record unchanged when it has none). Needs no unlocked vault, so a
 * lost device's passkey can be removed after signing in another way. */
export function removePasskey(record,credentialId){
  validateRecord(record);credential(credentialId);
  const next=JSON.parse(JSON.stringify(record));next.passkeys=(next.passkeys||[]).filter(item=>item.credentialId!==credentialId);
  return next;
}
/** Credential IDs that have a wrapper in this record. */
export function passkeyIds(record){validateRecord(record);return (record.passkeys||[]).map(item=>item.credentialId)}
/** Removes the in-memory key reference. Call on sign-out or when locking the app. */
export function destroy(vault){return keys.delete(vault)}
