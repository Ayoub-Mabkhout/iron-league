// Account-level choices kept on the server (/reminders): reminders, Diss mode and scheduled sprints. The last known values are
// remembered on this device only so the right screens show while offline; the server stays the source of truth.
import {api} from './api.js';
import {el} from './core.js';

export function privacyCard(headingLevel='h3'){
  return el('section',{class:'card'},
    el(headingLevel,{class:'card-title',text:'Privacy and encryption'}),
    el('p',{class:'hint',text:'Your browser encrypts progress photos before upload when your private vault is set up. Your password and recovery key stay on your device.'}),
    el('p',{class:'hint',text:'If you choose a photo for a coach question or a reminder, Iron League sends a separate copy the server can read for that purpose.'}),
    el('p',{class:'hint',text:'When you share a workout, its camera photo is stored on the server outside your private vault. If you finish privately, the server verifies the photo and discards it.'}),
    el('p',{class:'hint',text:'Profile details such as age, height and weight, along with workouts and ranks, are processed by Iron League outside the encrypted photo vault.'}));
}

let key='',value={};
export function selectAccount(id){
  key='train-settings:'+id;
  try{value=JSON.parse(localStorage.getItem(key))||{}}catch{value={}}
}
const keep=()=>{if(key)try{localStorage.setItem(key,JSON.stringify(value))}catch{}};
export const get=()=>value;
export const scheduledSprints=()=>!!value.scheduled_sprints;
export const diss=()=>!!value.roast;
export async function load(){try{value=await api('reminders');keep()}catch{}return value}
/** Resolves true when the server accepted the change. */
export async function save(patch){try{value=await api('reminders',{method:'PATCH',body:patch});keep();return true}catch{return false}}
