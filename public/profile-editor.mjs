const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const categories={preference:'Preferanser',hobby:'Interesser',routine:'Rutiner',school:'Skole',role:'Verv',relationship:'Relasjoner',other:'Annet'};
export function installProfileEditor(holder,{read,save,onSaved=()=>{}}) {
 let profile,signature='',saving=false;
 const dialog=el('dialog',undefined,'profile-edit-dialog');dialog.setAttribute('aria-label','Rediger profil');document.body.append(dialog);
 const button=(text,action)=>{const b=el('button',text);b.type='button';b.onclick=action;return b;};
 function open(member,fact,details=false) {
  dialog.replaceChildren();const form=el('form'),heading=el('h2',details?'Rediger profil':fact?'Rediger opplysning':'Legg til opplysning');
  const top=el('div',undefined,'profile-actions');top.append(heading,button('Lukk',()=>dialog.close()));form.append(top,el('p',member.name,'profile-person'));
  const field=(label,tag='input',value='')=>{const group=el('label',label),input=el(tag);input.value=value;group.append(input);form.append(group);return input;};
  let name,school,text,category,validTo;
  if(details){name=field('Navn','input',member.name);name.required=true;name.maxLength=100;if(member.id!=='family'){school=field('Klasse / trinn','input',member.schoolClass??'');school.maxLength=100;}}
  else {text=field('Opplysning','textarea',fact?.text??'');text.required=true;text.maxLength=2000;text.rows=4;text.placeholder=member.id==='family'?'Felles interesser, rutiner eller praktiske hensyn …':'Interesser, preferanser eller noe vi bør huske …';category=field('Kategori','select');for(const [key,label] of Object.entries(categories)){const option=el('option',label);option.value=key;category.append(option);}category.value=fact?.category??'other';validTo=field('Gjelder til (valgfritt)','input',fact?.validTo?.slice(0,10)??'');validTo.type='date';}
  const error=el('p',undefined,'profile-error');error.setAttribute('role','alert');form.append(error);
  const actions=el('div',undefined,'profile-actions'),submit=el('button','Lagre');submit.type='submit';actions.append(submit);
  const payload=()=>details?{action:'saveDetails',memberId:member.id,name:name.value,schoolClass:school?.value,expectedName:member.name,expectedSchoolClass:member.schoolClass??''}:{action:'saveFact',memberId:member.id,id:fact?.id,expectedText:fact?.text,text:text.value.trim(),category:category.value,validTo:validTo.value};
  async function commit(data){if(saving)return;saving=true;for(const b of actions.querySelectorAll('button'))b.disabled=true;try{await save(data);dialog.close();signature='';update(await read());await onSaved();}catch(e){error.textContent=e.message;}finally{saving=false;for(const b of actions.querySelectorAll('button'))b.disabled=false;}}
  if(fact)actions.append(button('Fjern',()=>commit({action:'removeFact',id:fact.id,expectedText:fact.text})));
  form.append(actions);form.onsubmit=e=>{e.preventDefault();commit(payload());};dialog.append(form);dialog.showModal();(name??text).focus();
 }
 function update(next){profile=next;const key=JSON.stringify(next);if(key===signature||dialog.open)return;signature=key;holder.replaceChildren();
  for(const member of [{id:'family',name:profile.familyName||'Hele familien'},...profile.members]){
   const card=el('section',undefined,'profile-card');const header=el('div',undefined,'profile-actions');header.append(el('h3',member.id==='family'?'Hele familien':member.name),button('Rediger profil',()=>open(member,null,true)));card.append(header,el('p',member.id==='family'?member.name:[member.role==='child'?'Barn':'Voksen',member.schoolClass].filter(Boolean).join(' · '),'profile-person'));
   const facts=profile.facts.filter(f=>f.memberId===member.id&&f.status!=='superseded'&&(!f.validTo||Date.parse(f.validTo)>Date.now()));
   if(!facts.length)card.append(el('p','Ingen opplysninger ennå.','profile-empty'));
   for(const fact of facts){const row=el('div',undefined,'profile-fact');const content=el('div');content.append(el('span',fact.text),el('small',(fact.status==='candidate'?'Må avklares · ':'')+(categories[fact.category]??'Annet')+(fact.validTo?' · til '+fact.validTo.slice(0,10):'')));row.append(content,button('Endre',()=>open(member,fact)));card.append(row);}
   card.append(button('＋ Legg til',()=>open(member)));holder.append(card);
  }
 }
 return {update,async refresh(){try{update(await read());}catch(e){holder.textContent=e.message;}},close(){dialog.close();signature='';}};
}
