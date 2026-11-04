import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {
  VERSION,KDF_VERSION,ITERATIONS,MAX_PLAINTEXT_BYTES,VaultError,passwordParameters,
  deriveAuthSecret,deriveRecoveryAuthSecret,authSecret,enroll,unlock,seal,open,sealJSON,openJSON,changePassword,rotateRecoveryKey,recover,destroy,
} from '../web/js/private-vault.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const PASSWORD='fictional test password only';
const META={kind:'workout',objectId:'workout-test-1',revision:3};
const clone=value=>JSON.parse(JSON.stringify(value));
const flip=text=>{const bytes=Buffer.from(text,'base64url');bytes[0]^=1;return bytes.toString('base64url')};
let owner;
before(async()=>{owner=await enroll(PASSWORD,'synthetic-user-1')});

test('pre-authentication derivation matches enrollment with public parameters',async()=>{
  const params=owner.record.password.parameters;
  assert.deepEqual(Object.keys(params).sort(),['version','kdf','hash','iterations','salt'].sort());
  assert.equal(params.version,KDF_VERSION);assert.equal(params.iterations,600000);assert.equal(ITERATIONS,600000);
  assert.match(params.salt,/^[A-Za-z0-9_-]{22}$/);
  assert.equal(await deriveAuthSecret(PASSWORD,params),owner.authSecret);
  assert.equal(authSecret,deriveAuthSecret);assert.match(owner.authSecret,/^[A-Za-z0-9_-]{43}$/);
  assert.match(owner.recoveryKey,/^[A-Za-z0-9_-]{43}$/);
  assert.match(owner.recoveryAuthSecret,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(owner.recoveryAuthSecret,await deriveRecoveryAuthSecret(owner.recoveryKey,owner.record.recovery.salt));
  assert.notEqual(owner.recoveryAuthSecret,owner.recoveryKey);assert.notEqual(owner.recoveryAuthSecret,owner.authSecret);
});

test('text, JSON and binary payloads round-trip without mutating source bytes',async()=>{
  const data={sets:[{reps:8,weight_kg:40}],notes:'synthetic résumé'};
  const encrypted=await sealJSON(owner.vault,META,data);
  assert.deepEqual(await openJSON(owner.vault,META,encrypted),data);
  assert.equal(encrypted.version,VERSION);assert.equal(encrypted.userId,'synthetic-user-1');
  assert.equal(Buffer.from(encrypted.nonceB64,'base64url').length,12);
  assert.equal(encrypted.kind,META.kind);assert.equal(encrypted.objectId,META.objectId);assert.equal(encrypted.revision,3);
  const binary=new Uint8Array([0,255,1,2,128]);
  const binaryEnvelope=await seal(owner.vault,{kind:'photo',objectId:'test-photo',revision:1},binary);
  assert.deepEqual(await open(owner.vault,{kind:'photo',objectId:'test-photo',revision:1},binaryEnvelope),binary);
  assert.deepEqual([...binary],[0,255,1,2,128]);
  const empty=await seal(owner.vault,META,'');assert.equal((await open(owner.vault,META,empty)).length,0);
});

test('each encryption uses a fresh nonce and independent ciphertext',async()=>{
  const first=await seal(owner.vault,META,'same plaintext'),second=await seal(owner.vault,META,'same plaintext');
  assert.notEqual(first.nonceB64,second.nonceB64);assert.notEqual(first.cipherB64,second.cipherB64);
});

test('ciphertext and nonce tampering are rejected by authentication',async()=>{
  const encrypted=await seal(owner.vault,META,'private fixture');
  await assert.rejects(open(owner.vault,META,{...encrypted,cipherB64:flip(encrypted.cipherB64)}),VaultError);
  await assert.rejects(open(owner.vault,META,{...encrypted,nonceB64:flip(encrypted.nonceB64)}),VaultError);
});

test('AAD prevents kind, object and revision swaps even when expected metadata is changed too',async()=>{
  const encrypted=await seal(owner.vault,META,'private fixture');
  for(const update of [{kind:'profile'},{objectId:'workout-test-2'},{revision:4}]){
    await assert.rejects(open(owner.vault,{...META,...update},{...encrypted,...update}),/authentication failed/);
  }
  for(const update of [{version:2},{userId:'synthetic-user-2'},{keyId:flip(encrypted.keyId)}]){
    await assert.rejects(open(owner.vault,META,{...encrypted,...update}),VaultError);
  }
  await assert.rejects(open(owner.vault,{...META,userId:'synthetic-user-2'},encrypted),VaultError);
});

test('wrong password or recovery key cannot unlock a valid record',async()=>{
  await assert.rejects(unlock('wrong fictional password',owner.record),VaultError);
  await assert.rejects(recover(flip(owner.recoveryKey),owner.record,'another password'),VaultError);
  const altered=clone(owner.record);altered.password.wrappedMaster.cipherB64=flip(altered.password.wrappedMaster.cipherB64);
  await assert.rejects(unlock(PASSWORD,altered),VaultError);
});

test('password rotation keeps the master key, recovery wrapper and existing objects',async()=>{
  const encrypted=await sealJSON(owner.vault,META,{workout:'preserved'});
  const params=passwordParameters(),rotated=await changePassword(owner.vault,owner.record,'new fictional password',params);
  assert.equal(rotated.record.keyId,owner.record.keyId);
  assert.deepEqual(rotated.record.recovery,owner.record.recovery);
  assert.equal(rotated.record.password.wrappedMaster.revision,2);
  assert.deepEqual(rotated.record.password.parameters,params);
  assert.notEqual(rotated.authSecret,owner.authSecret);
  assert.equal(rotated.authSecret,await deriveAuthSecret('new fictional password',params));
  const session=await unlock('new fictional password',rotated.record);
  assert.deepEqual(await openJSON(session.vault,META,encrypted),{workout:'preserved'});
  await assert.rejects(unlock(PASSWORD,rotated.record),VaultError);
  destroy(session.vault);
});

test('recovery rewraps the same master under a new password without any server calls',async()=>{
  const encrypted=await seal(owner.vault,META,'recover this');
  const params=passwordParameters(),restored=await recover(owner.recoveryKey,owner.record,'recovered fictional password',params);
  assert.equal(restored.record.keyId,owner.record.keyId);
  assert.deepEqual(restored.record.recovery,owner.record.recovery);
  assert.equal(new TextDecoder().decode(await open(restored.vault,META,encrypted)),'recover this');
  const session=await unlock('recovered fictional password',restored.record);
  assert.equal(session.authSecret,restored.authSecret);
  assert.equal(restored.recoveryAuthSecret,owner.recoveryAuthSecret);
  destroy(restored.vault);destroy(session.vault);
});

test('explicit recovery-key rotation produces a new proof and preserves encrypted objects',async()=>{
  const encrypted=await seal(owner.vault,META,'same master key');
  const rotated=await rotateRecoveryKey(owner.vault,owner.record);
  assert.notEqual(rotated.recoveryKey,owner.recoveryKey);assert.notEqual(rotated.recoveryAuthSecret,owner.recoveryAuthSecret);
  assert.deepEqual(rotated.record.password,owner.record.password);
  await assert.rejects(recover(owner.recoveryKey,rotated.record,'rotated password'),VaultError);
  const restored=await recover(rotated.recoveryKey,rotated.record,'rotated password');
  assert.equal(new TextDecoder().decode(await open(restored.vault,META,encrypted)),'same master key');destroy(restored.vault);
  const replaced=await recover(owner.recoveryKey,owner.record,'replacement password',passwordParameters(),{rotateRecovery:true});
  assert.notEqual(replaced.recoveryAuthSecret,owner.recoveryAuthSecret);
  assert.equal(replaced.recoveryAuthSecret,await deriveRecoveryAuthSecret(replaced.recoveryKey,replaced.record.recovery.salt));
  assert.equal(new TextDecoder().decode(await open(replaced.vault,META,encrypted)),'same master key');destroy(replaced.vault);
});

test('server-known auth secret is domain separated from the wrapping and master keys',async()=>{
  const encrypted=await seal(owner.vault,META,'not readable with authentication secret');
  const authKey=await crypto.subtle.importKey('raw',Buffer.from(owner.authSecret,'base64url'),{name:'AES-GCM'},false,['decrypt']);
  const aad=envelope=>new TextEncoder().encode(JSON.stringify(['iron-league/private-vault/object/v1',envelope.version,envelope.userId,envelope.keyId,envelope.kind,envelope.objectId,envelope.revision]));
  for(const envelope of [encrypted,owner.record.password.wrappedMaster]){
    await assert.rejects(crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(envelope.nonceB64,'base64url'),additionalData:aad(envelope),tagLength:128},authKey,Buffer.from(envelope.cipherB64,'base64url')));
  }
  const recoveryAuthKey=await crypto.subtle.importKey('raw',Buffer.from(owner.recoveryAuthSecret,'base64url'),{name:'AES-GCM'},false,['decrypt']);
  const recovery=owner.record.recovery.wrappedMaster;
  await assert.rejects(crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(recovery.nonceB64,'base64url'),additionalData:aad(recovery),tagLength:128},recoveryAuthKey,Buffer.from(recovery.cipherB64,'base64url')));
  const serialized=JSON.stringify(owner.record);
  assert.ok(!serialized.includes(owner.authSecret));assert.ok(!serialized.includes(owner.recoveryKey));assert.ok(!serialized.includes(PASSWORD));
});

test('vault handles expose no key material and locking removes access',async()=>{
  const session=await unlock(PASSWORD,owner.record);
  assert.deepEqual(Object.keys(session.vault).sort(),['version','userId','keyId'].sort());
  assert.equal(destroy(session.vault),true);assert.equal(destroy(session.vault),false);
  await assert.rejects(seal(session.vault,META,'locked'),/locked/);
  await assert.rejects(seal({...owner.vault},META,'copied handle'),/locked/);
});

test('unsupported KDFs, weak iteration overrides, invalid metadata and noncanonical encodings are rejected',async()=>{
  const params=owner.record.password.parameters;
  await assert.rejects(deriveAuthSecret(PASSWORD,{...params,iterations:1}),VaultError);
  await assert.rejects(deriveAuthSecret(PASSWORD,{...params,version:'unknown'}),VaultError);
  await assert.rejects(deriveAuthSecret(PASSWORD,{...params,salt:params.salt+'='}),VaultError);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias=params.salt.slice(0,-1)+alphabet[alphabet.indexOf(params.salt.at(-1))^1];
  await assert.rejects(deriveAuthSecret(PASSWORD,{...params,salt:alias}),VaultError);
  for(const meta of [{...META,revision:-1},{...META,revision:1.5},{...META,revision:Number.MAX_SAFE_INTEGER+1},{...META,objectId:''}]){
    await assert.rejects(seal(owner.vault,meta,'invalid'),VaultError);
  }
});

test('oversized data and malformed encrypted envelopes are rejected before decryption',async()=>{
  await assert.rejects(seal(owner.vault,META,new Uint8Array(MAX_PLAINTEXT_BYTES+1)),/too large/);
  const encrypted=await seal(owner.vault,META,'small');
  await assert.rejects(open(owner.vault,META,{...encrypted,nonceB64:'A'}),VaultError);
  await assert.rejects(open(owner.vault,META,{...encrypted,cipherB64:'A'.repeat(Math.ceil((MAX_PLAINTEXT_BYTES+16)*4/3)+1)}),VaultError);
  await assert.rejects(openJSON(owner.vault,META,await seal(owner.vault,META,'not JSON')),/not valid JSON/);
});
