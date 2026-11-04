// WebAuthn ceremonies for passkeys (synced by Google Password Manager, iCloud Keychain and others). Iron League uses the
// passkey's PRF extension: after the device checks the owner's fingerprint, face or screen lock it returns 32 bytes for
// our fixed salt. Those bytes stay on this device; private-vault.js derives the sign-in secret and the vault key from
// them. The server never sees them and doesn't check WebAuthn signatures, so no challenge is fetched from it.
// PRF reference: https://w3c.github.io/webauthn/#prf-extension
import * as vault from './private-vault.js';

export const UNSUPPORTED="This device's passkeys can't unlock encrypted photos; keep your recovery key.";
export class PasskeyError extends Error{constructor(message,code){super(message);this.name='PasskeyError';this.code=code}}

const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=text=>Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-text.length%4)%4)),c=>c.charCodeAt(0));
const challenge=()=>crypto.getRandomValues(new Uint8Array(32));

/** Whether this browser can try passkeys at all. Whether they return PRF output is known only after a ceremony. */
export function available(){return !!(globalThis.isSecureContext&&globalThis.PublicKeyCredential&&navigator.credentials?.create&&navigator.credentials?.get)}

function failed(error){
  if(error instanceof PasskeyError)return error;
  // NotAllowedError covers a cancelled prompt, a timeout and "no passkey for this site" alike.
  if(error?.name==='NotAllowedError'||error?.name==='AbortError')return new PasskeyError('The passkey prompt was closed.','cancelled');
  if(error?.name==='InvalidStateError')return new PasskeyError('This device already has a passkey for your profile.','exists');
  return new PasskeyError("Couldn't use a passkey on this device.",'failed');
}
function prfOf(credential){const first=credential.getClientExtensionResults?.()?.prf?.results?.first;return first?new Uint8Array(first).slice():null}

/** Asks the password manager to drop a passkey that Iron League won't use, where the browser supports that signal. */
export function forget(credentialId){
  try{globalThis.PublicKeyCredential?.signalUnknownCredential?.({rpId:location.hostname,credentialId})?.catch?.(()=>{})}catch{}
}

/** A passkey assertion with its PRF output. Without ids the browser offers every Iron League passkey (discoverable). */
export async function get(ids=null){
  if(!available())throw new PasskeyError(UNSUPPORTED,'unsupported');
  const publicKey={challenge:challenge(),userVerification:'required',extensions:{prf:{eval:{first:await vault.passkeyPrfSalt()}}}};
  if(ids)publicKey.allowCredentials=ids.map(id=>({type:'public-key',id:unb64(id)}));
  let credential;try{credential=await navigator.credentials.get({publicKey})}catch(e){throw failed(e)}
  const prf=prfOf(credential);if(!prf)throw new PasskeyError(UNSUPPORTED,'unsupported');
  return {credentialId:b64(new Uint8Array(credential.rawId)),prf};
}

/** A new discoverable passkey for this profile and its PRF output. Throws 'unsupported' (and asks the password manager
 * to drop the new passkey) when this authenticator has no PRF, so nothing gets saved for it. */
export async function create(account,existing=[]){
  if(!available())throw new PasskeyError(UNSUPPORTED,'unsupported');
  const first=await vault.passkeyPrfSalt(),encoder=new TextEncoder();
  let credential;
  try{credential=await navigator.credentials.create({publicKey:{
    rp:{name:'Iron League'},
    user:{id:encoder.encode(account.id),name:account.name,displayName:account.name},
    challenge:challenge(),
    pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
    authenticatorSelection:{residentKey:'required',requireResidentKey:true,userVerification:'required'},
    excludeCredentials:existing.map(id=>({type:'public-key',id:unb64(id)})),
    extensions:{prf:{eval:{first}}},
  }})}catch(e){throw failed(e)}
  const credentialId=b64(new Uint8Array(credential.rawId)),result=credential.getClientExtensionResults?.()?.prf;
  let prf=prfOf(credential);
  // Some authenticators only report prf.enabled at creation; the output then comes from a first sign-in with it.
  if(!prf&&result?.enabled===true){try{prf=(await get([credentialId])).prf}catch(e){if(failed(e).code!=='unsupported'){forget(credentialId);throw failed(e)}}}
  if(!prf){forget(credentialId);throw new PasskeyError(UNSUPPORTED,'unsupported')}
  return {credentialId,prf};
}
