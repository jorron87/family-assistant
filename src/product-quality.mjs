// A transparent category-specific ingredient-content score, not a health rating.
// It never approves equivalence, changes a price, or supplies missing label facts.
export const QUALITY_MODEL_VERSION='ingredient-content-v14';
const clean=v=>String(v??'').normalize('NFC').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const number=v=>Number(v.replace(',','.'));
const decimal='(?<![\\d.,])(\\d{1,4}(?:[.,]\\d{1,3})?)';
const limitations=['Måler dokumentert råvareinnhold innen samme varetype og målegrunnlag.','Ingen samlet helse-, smak-, dyrevelferds- eller produksjonskvalitet er beregnet.','Sukkerarter og salt vises separat; de er ikke skjulte vekter i råvarescoren.'];
function components(text){let depth=0,start=0;const out=[];for(let at=0;at<text.length;at++){if(text[at]==='('||text[at]==='[')depth++;if(text[at]===')'||text[at]===']')depth=Math.max(0,depth-1);const decimalComma=/\d/.test(text[at-1]??'')&&/\d/.test(text[at+1]??'');if(!depth&&(text[at]===';'||text[at]===','&&!decimalComma)){out.push(text.slice(start,at).trim());start=at+1;}}out.push(text.slice(start).trim());return out;}
function uniqueFact(found,max){if(!found.length)return{fact:null,reason:'missing-declared-amount'};const values=[...new Set(found.map(f=>f.value))];if(values.some(v=>!Number.isFinite(v)||v<0||v>max))return{fact:null,reason:'invalid-declared-amount'};if(values.length!==1)return{fact:null,reason:'conflicting-declared-amounts'};return{fact:{value:values[0],evidence:found.map(({text,field})=>({text,field}))},reason:null};}
function percent(ingredients,token,{allowSpeciesList=false}={}){
 const qualifiers='(?:(?:øko(?:logisk(?:e)?)?|ristede?|malte?|organic|roasted|ground|og)\\s+)*';
 const patterns=[
  new RegExp('^'+qualifiers+'(?:'+token+')\\s*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i'),
  new RegExp('^'+decimal+'\\s*%\\s*'+qualifiers+'(?:'+token+')(?![\\p{L}\\p{N}_]|\\s+av\\b)','iu')
 ];
 if(allowSpeciesList)patterns.push(new RegExp('^(?:'+token+')\\s*\\[[^\\[\\]]+\\]\\s*'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i'));
 const found=[];for(const part of components(ingredients))for(const re of patterns){const m=part.match(re);if(m)found.push({value:number(m[1]),text:m[0],field:'ingredients'});}return uniqueFact(found,100);
}
function fishsticksPercent(ingredients){
 const parts=components(ingredients),fish='(?:hakket\\s+fisk|fiskekjøtt\\s+av\\s+stillehavslysing|fisk\\s*-\\s*alaska\\s*pollock|alaska\\s*pollock(?:\\s+filet)?|fileter\\s+av\\s+alaska\\s*pollock|seifilet|fisk(?:ekjøtt)?)';
 const re=new RegExp('^'+fish+'\\s*\\*?\\s*(?:\\([^()]*\\)\\s*)*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i');
 const found=[];for(const part of parts){const m=part.match(re);if(m)found.push({value:number(m[1]),text:m[0],field:'ingredients'});else if(/^(?:fisk|torsk|sei(?:filet)?|hyse|laks|pollock|alaska\s*pollock|stillehavslysing|surimi|lange|brosme|kolmule|makrell|ørret|kveite|hvitlaks|kvitlaks|hvitfisk|krabbe|reker|sjømat)\b/i.test(part))return{fact:null,reason:'ambiguous-fish-components'};}
 return uniqueFact(found,100);
}
// A gratin may also contain fish stock. Measure the declared main fish
// ingredient, not an inferred total including the stock's unknown quantity.
function fishGratinPercent(ingredients){
 const fish='(?:seifilet|torskefilet|hysefilet|sei|torsk|hyse|fiskefilet|fisk)';
 const re=new RegExp('^'+fish+'\\s*\\*?\\s*(?:\\([^()]*\\)\\s*)*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i');
 const found=[];
 for(const part of components(ingredients)){
  if(/^fiske(?:fond|font)\b/i.test(part))continue;
  if(!/^(?:(?:hakket|finhakket|røkt|renskåret)\s+)?(?:sei|torsk|hyse|fisk|laks|ørret|pollock|alaska\s+pollock|stillehavslysing|makrell|sild|lange|brosme|kolmule|kveite|hvitlaks|kvitlaks|hvitfisk|reker|krabbe|sjømat|surimi)/i.test(part))continue;
  const m=part.match(re);if(!m)return{fact:null,reason:'ambiguous-main-fish-component'};
  found.push({value:number(m[1]),text:m[0],field:'ingredients'});
 }
 if(found.length>1)return{fact:null,reason:'multiple-main-fish-components'};
 return uniqueFact(found,100);
}
// Compare only an explicitly declared share of a single chicken-meat ingredient.
// Cooking yield, compound ingredients, and chicken-derived aroma are not meat share.
function chickenColdcutPercent(ingredients){
 const meat='(?:(?:kvernet|hakket|renskåret|norsk)\\s+)*(?:kyllingfilet|kyllingbryst|brystkjøtt\\s+av\\s+kylling)';
 const re=new RegExp('^'+meat+'\\s*\\*?\\s*(?:uten\\s+skinn\\s*)?(?:\\(opprinnelse[^()]*\\)\\s*)?\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i');
 const found=[];
 for(const part of components(ingredients)){
  if(/^kyllingaroma\b/i.test(part))continue;
  if(!/kylling/i.test(part))continue;
  const m=part.match(re);if(!m)return{fact:null,reason:'ambiguous-chicken-components'};
  found.push({value:number(m[1]),text:m[0],field:'ingredients'});
 }
 if(found.length>1)return{fact:null,reason:'multiple-chicken-components'};
 return uniqueFact(found,100);
}
// A single explicitly quantified meat ingredient can be compared across the
// reviewed cooked-ham groups. Yield statements are a different measurement.
function cookedHamPercent(ingredients){
 const meat='(?:(?:norsk|renskåret)\\s+)*(?:(?:sammensatte\\s+stykker\\s+av\\s+)?svinekjøtt(?:\\s+av\\s+skinke)?|skinke\\s+av\\s+svin)';
 const re=new RegExp('^'+meat+'\\s*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i');
 const found=[];
 for(const part of components(ingredients)){
  if(!/svin|skinke/i.test(part))continue;
  const m=part.match(re);if(!m)return{fact:null,reason:'ambiguous-pork-components'};
  found.push({value:number(m[1]),text:m[0],field:'ingredients'});
 }
 if(found.length>1)return{fact:null,reason:'multiple-pork-components'};
 return uniqueFact(found,100);
}
function potatoSaladPercent(ingredients){
 const re=new RegExp('^potet(?:er|skiver)?\\s*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i');
 const found=[];
 for(const part of components(ingredients)){
  if(!/potet/i.test(part))continue;
  const m=part.match(re);if(!m)return{fact:null,reason:'ambiguous-potato-components'};
  found.push({value:number(m[1]),text:m[0],field:'ingredients'});
 }
 if(found.length>1)return{fact:null,reason:'multiple-potato-components'};
 return uniqueFact(found,100);
}
// The explicit wholegrain-flour percentage describes the product recipe. A
// claim that the wheat itself is wholegrain does not establish the same basis.
function wholegrainPastaPercent(ingredients){
 const componentsWithWholegrain=components(ingredients).filter(part=>/fullkorn|sammalt/i.test(part));
 if(componentsWithWholegrain.length!==1)return{fact:null,reason:componentsWithWholegrain.length?'multiple-wholegrain-components':'missing-declared-amount'};
 const part=componentsWithWholegrain[0];
 if((part.match(/fullkorn|sammalt/gi)??[]).length!==1)return{fact:null,reason:'multiple-wholegrain-components'};
 const re=new RegExp('^fullkorns?mel\\s+av\\s+durumhvete\\s*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*\\(?\\s*av\\b)','i');
 const m=part.match(re);return m?uniqueFact([{value:number(m[1]),text:m[0],field:'ingredients'}],100):{fact:null,reason:'missing-declared-amount'};
}
// Liver share is not total meat and does not imply any specific iron content.
function porkLiverPatePercent(ingredients){
 const parts=components(ingredients).filter(part=>/lever/i.test(part));
 if(parts.length!==1)return{fact:null,reason:parts.length?'multiple-liver-components':'missing-declared-amount'};
 if((parts[0].match(/lever/gi)??[]).length!==1)return{fact:null,reason:'multiple-liver-components'};
 const re=new RegExp('^(?:ingredienser:\\s*)?(?:svinelever|lever\\s+av\\s+svin)\\s*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*\\(?\\s*(?:av|hvorav)\\b)','i');
 const m=parts[0].match(re);if(!m)return{fact:null,reason:'ambiguous-liver-component'};
 if(number(m[1])===0)return{fact:null,reason:'missing-or-invalid-liver-share'};
 return uniqueFact([{value:number(m[1]),text:m[0],field:'ingredients'}],100);
}
// Only add individually declared tomato ingredients when every tomato component
// is an unambiguous, directly declared un-concentrated ingredient. Tomato purée,
// juice or an undeclared component would make the total a partial lower bound.
function pastaTomatoPercent(ingredients){
 const parts=components(ingredients),found=[],seen=new Set();for(const part of parts){
  if(!/tomat/i.test(part))continue;
  const re=new RegExp('^(?:hakkede?\\s+)?(?:tomat(?:er)?|daddeltomat(?:er)?)\\s*\\*?\\s*(?:\\(\\s*)?'+decimal+'\\s*%(?!\\s*\\)?\\s*av\\b)','i'),m=part.match(re);
  if(!m)return{fact:null,reason:'incomplete-or-concentrated-tomato-components'};
  const kind=/daddeltomat/i.test(m[0])?'daddeltomat':'tomat';if(seen.has(kind))return{fact:null,reason:'ambiguous-repeated-tomato-component'};seen.add(kind);
  const value=number(m[1]);if(!Number.isFinite(value)||value<0||value>100)return{fact:null,reason:'invalid-declared-amount'};
  found.push({value,text:m[0],field:'ingredients'});
 }
 if(!found.length)return{fact:null,reason:'missing-declared-amount'};
 const value=found.reduce((a,x)=>a+x.value,0);if(value>100)return{fact:null,reason:'invalid-declared-amount'};
 return{fact:{value:Math.round(value*1000)/1000,evidence:found.map(({text,field})=>({text,field}))},reason:null};
}
function tomatoInput(ingredients,description,crossDescription='',primaryDescription=''){const found=[];for(const [field,text]of [['ingredients',ingredients],['description',description],['crossSourceLabel.description',crossDescription],['primaryLabel.description',primaryDescription]]){
 const patterns=[
  {re:new RegExp('tomater?\\s*\\(\\s*'+decimal+'\\s*g\\s*(?:per|pr\\.?|i|til)\\s*100\\s*g\\s*(?:tomat)?ketchup','gi'),convert:m=>number(m[1])},
  {re:new RegExp('(?:til|per|pr\\.?)\\s*100\\s*g\\s*(?:tomat)?ketchup.{0,35}?'+decimal+'\\s*g\\s*(?:friske\\s+|ferske\\s+)?tomater','gi'),convert:m=>number(m[1])},
  {re:new RegExp(decimal+'\\s*(?:kg|kilo)\\s+tomater\\s+(?:til|per|pr\\.?)\\s*'+decimal+'\\s*(?:kg|kilo)\\s+(?:tomat)?ketchup','gi'),convert:m=>number(m[1])/number(m[2])*100},
  {re:new RegExp(decimal+'\\s*(?:g|gram)\\s+(?:friske\\s+|ferske\\s+)?(?:solmodne\\s+)?tomater\\s+(?:for å lage|til)\\s*'+decimal+'\\s*(?:g|gram)\\s+(?:tomat)?ketchup','gi'),convert:m=>number(m[1])/number(m[2])*100}
 ];for(const {re,convert}of patterns)for(const m of text.matchAll(re))found.push({value:convert(m),text:m[0],field});
 }return uniqueFact(found,1000);}
function profile(groupId){
 const id=String(groupId??'').split('--')[0];
 if(/^ketchup-(?:standard|no-sugar)$/.test(id))return{id:'ketchup',label:'Tomater brukt per 100 g ketchup',basis:'tomato-input-g-per-100g',unit:'g/100 g',target:200};
 if(/^peanut-butter-(?:100|near-pure|standard|crunchy-sweet)$/.test(id))return{id:'peanut-butter',label:'Deklarert peanøttandel',basis:'declared-ingredient-percent',unit:'%',target:100,token:'(?:peanuts\\s*\\/\\s*)?(?:tørristede?\\s+)?peanøtter|peanøttkjerner|peanuts',single:/^(?:økologiske?\s+|ristede\s+)?(?:peanøtter|peanuts)\*?(?:\s*\(100\s*%\))?\.?$/i};
 if(id==='hazelnut-chocolate-spread')return{id:'hazelnut-spread',label:'Deklarert hasselnøttandel',basis:'declared-ingredient-percent',unit:'%',target:100,token:'(?:hasselnøtt(?:er|kjerner|masse)?|hasselnötter)(?:\\s*/\\s*hasselnøddekerner)?'};
 if(['fishcakes-ordinary','fishcakes-high','fishcakes-very-high'].includes(id))return{id:'fishcakes',label:'Deklarert total fiskeandel',basis:'declared-ingredient-percent',unit:'%',target:100,token:'fisk'};
 if(id==='fishsticks-breaded')return{id:'fishsticks',label:'Deklarert fiskeandel',basis:'declared-fish-percent',unit:'%',target:100};
 if(id==='chicken-coldcuts-plain')return{id:'chicken-coldcut',label:'Deklarert andel av kyllingkjøttingrediensen',basis:'declared-chicken-meat-ingredient-percent',unit:'%',target:100};
 if(['ham-cooked','ham-cooked-sliced-80-89'].includes(id))return{id:'cooked-ham',label:'Deklarert andel av svinekjøttingrediensen',basis:'declared-pork-meat-ingredient-percent',unit:'%',target:100};
 if(['potato-salad-creme-fraiche','potato-salad-creme-practical'].includes(id))return{id:'potato-salad',label:'Deklarert potetandel',basis:'declared-potato-ingredient-percent',unit:'%',target:100};
 if(/^fish-gratin-macaroni-(?:practical-frozen|frozen-(?:20|30)pct)$/.test(id))return{id:'fish-gratin',label:'Deklarert andel av hovedfiskingrediensen',basis:'declared-main-fish-ingredient-percent',unit:'%',target:100};
 if(id==='pasta-sauce-tomato-mild-herbs')return{id:'pasta-tomato',label:'Deklarert tomatandel i saus',basis:'declared-unconcentrated-tomato-percent',unit:'%',target:100};
 if(id==='beans-white-in-tomato-sauce')return{id:'beans-in-tomato',label:'Deklarert bønneandel i tomatbønner',basis:'declared-bean-percent',unit:'%',target:100,token:'(?:utbløtte\\s+)?(?:hvite\\s+)?bønner'};
 if(/^crispbread-/.test(id))return{id:'crispbread',label:'Deklarert kostfiber per 100 g',basis:'dietary-fiber-g-per-100g',unit:'g/100 g',target:30};
 if(id==='bread-wholegrain')return{id:'wholegrain-bread',label:'Deklarert kostfiber per 100 g grovbrød',basis:'dietary-fiber-g-per-100g',unit:'g/100 g',target:15};
 if(id==='pasta-wholegrain')return{id:'wholegrain-pasta',label:'Deklarert andel fullkornmel i pasta',basis:'declared-wholegrain-flour-ingredient-percent',unit:'%',target:100};
 if(id==='pork-liver-pate')return{id:'pork-liver-pate',label:'Deklarert andel svinelever',basis:'declared-pork-liver-ingredient-percent',unit:'%',target:100};
 if(['muesli-fruit-raisin-pineapple-banana','muesli-fruit-practical'].includes(id))return{id:'fruit-muesli',label:'Deklarert kostfiber per 100 g fruktmüsli',basis:'dietary-fiber-g-per-100g',unit:'g/100 g',target:15};
 if(/^(?:fruit-spread-|jam-)/.test(id)){
  const fruit=[['blueberry','(?:vill)?blåbær'],['blackcurrant','solbær'],['apricot','aprikos(?:er)?'],['orange','appelsin(?:er)?'],['raspberry','bringebær'],['strawberry','jordbær']].find(([word])=>id.includes(word));
  if(fruit)return{id:'fruit-spread',subtype:fruit[0],label:'Deklarert frukt-/bærandel',basis:'declared-ingredient-percent',unit:'%',target:100,token:fruit[1]+'|frukt|bær',fruit:fruit[1]};
 }
 return null;
}
/** Score only current, reviewed product metadata in a supported category.
 * `reviewCurrent` must come from the equivalence reader, never a price flag.
 * Equal score numbers with different comparisonKey values are incomparable.
 */
export function scoreProductQuality(product,{groupId,reviewCurrent=false}={}){
 const p=profile(groupId),base={modelVersion:QUALITY_MODEL_VERSION,label:'Råvarekvalitet',score:null,status:p?'unknown':'not-applicable',comparisonKey:null,criterion:p?.label??null,measurement:null,context:[],nutrition:null,reasons:[],limitations:[...limitations]};
 if(!reviewCurrent)return{...base,status:'review-required',reasons:['current-product-review-required']};
 if(!p)return{...base,reasons:['no-category-model']};
 if(p.id==='crispbread'){base.label='Kostfiber';base.limitations=['Måler kun deklarert kostfiber per 100 g knekkebrød.','30 g per 100 g er modellens skaleringsmål, ikke en anbefalt inntaksmengde eller grenseverdi.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering, og viser ikke direkte fullkornsandel.'];}
 if(p.id==='fruit-muesli'){base.label='Kostfiber';base.limitations=['Måler kun deklarert kostfiber per 100 g spiseklar fruktmüsli.','15 g per 100 g er modellens skaleringsmål, ikke en anbefalt inntaksmengde eller grenseverdi.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering, og viser ikke direkte fullkornsandel.'];}
 if(p.id==='wholegrain-bread'){base.label='Kostfiber';base.limitations=['Måler kun deklarert kostfiber per 100 g ferdig grovbrød.','15 g per 100 g er modellens skaleringsmål, ikke en anbefaling eller en grenseverdi.','Dette er ikke fullkornsandel eller en samlet helse-, smaks- eller kvalitetsvurdering; null oppgis som uavklart for denne gruppen.'];}
 if(p.id==='wholegrain-pasta')base.limitations=['Måler kun uttrykkelig deklarert andel fullkornmel i hele pastaoppskriften.','Fullkornsmerking av hveten alene, fiberinnhold og andel av kornet er andre målegrunnlag.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering.'];
 if(p.id==='pork-liver-pate')base.limitations=['Måler bare uttrykkelig deklarert andel svinelever i hele leverposteien.','Dette er ikke total kjøttandel eller en dokumentert mengde jern; fett, salt og øvrig oppskrift varierer og vises separat.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering.'];
 if(p.id==='pasta-tomato')base.limitations=['Måler bare uttrykkelig deklarerte tomatandeler i mild ferdig pastasaus.','Tomatpuré, konsentrert juice og uoppgitte tomatandeler gjør totalen uavklart og gir ingen score.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering; sukker og salt vises separat.'];
 if(p.id==='beans-in-tomato')base.limitations=['Måler kun deklarert bønneandel i det spiseklare helproduktet med saus.','Bønnenes vanninnhold og øvrig oppskrift kan variere; sukker og salt vises separat.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering.'];
 if(p.id==='chicken-coldcut')base.limitations=['Måler kun uttrykkelig deklarert andel av én kyllingkjøttingrediens i pålegget.','Steking, oppskrift, konsistens og saltinnhold kan variere; kjøttmengde brukt per 100 g ferdig vare har et annet målegrunnlag.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering.'];
 if(p.id==='cooked-ham')base.limitations=['Måler kun uttrykkelig deklarert andel av én svinekjøttingrediens i kokt skinke.','Sammensatte kjøttstykker, renskåret kjøtt, tilberedning og saltinnhold kan variere; kjøttmengde brukt per 100 g ferdig vare har et annet målegrunnlag.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering.'];
 if(p.id==='potato-salad')base.limitations=['Måler kun uttrykkelig deklarert potetandel i den ferdige potetsalaten.','Fett, salt, sukker, crème fraîche og øvrige ingredienser beskriver andre egenskaper og vises separat.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering.'];
 if(p.id==='fish-gratin')base.limitations=['Måler bare den uttrykkelig deklarerte andelen av hovedfiskingrediensen i fiskegratengen.','Eventuell fiskefond er ikke inkludert; fiskeslag, makaroni og øvrig oppskrift kan variere.','Dette er ikke en samlet helse-, smaks- eller kvalitetsvurdering; sukker og salt vises separat.'];
 const cross=product?.nutritionObservation?.crossSourceLabel,primary=product?.nutritionObservation?.primaryLabel,ingredients=clean(product?.ingredients||cross?.ingredients),description=clean(product?.description),m=product?.nutrition?.basis==='g'?product.nutrition.per100:null;
 const withheldFiber=!!product?.nutritionObservation?.fiberConflict||p.id==='wholegrain-bread'&&m?.fiber===0;
 base.nutrition=m?{basis:'per 100 g',fat:Number.isFinite(m.fat)?m.fat:null,fiber:!withheldFiber&&Number.isFinite(m.fiber)?m.fiber:null,sugars:Number.isFinite(m.sugars)?m.sugars:null,salt:Number.isFinite(m.salt)?m.salt:null}:null;
 let result;
 if(p.id==='crispbread'||p.id==='fruit-muesli'||p.id==='wholegrain-bread'){
  const fiber=m?.fiber,sourceUrl=product?.nutrition?.sourceUrl;
  result=product?.nutritionObservation?.fiberConflict?{fact:null,reason:'conflicting-fiber-labels'}:Number.isFinite(fiber)&&(fiber>0||fiber===0&&p.id!=='wholegrain-bread')&&fiber<=100&&/^https:\/\/\S+$/i.test(sourceUrl??'')?{fact:{value:fiber,evidence:[{text:`Kostfiber ${fiber} g per 100 g`,field:'nutrition.per100.fiber'}]},reason:null}:{fact:null,reason:'missing-or-invalid-fiber-per-100g'};
 }else if(p.id==='fishsticks'){
  result=fishsticksPercent(ingredients);
 }else if(p.id==='fish-gratin'){
  result=fishGratinPercent(ingredients);
 }else if(p.id==='chicken-coldcut'){
  result=chickenColdcutPercent(ingredients);
 }else if(p.id==='cooked-ham'){
  result=cookedHamPercent(ingredients);
 }else if(p.id==='potato-salad'){
  result=potatoSaladPercent(ingredients);
 }else if(p.id==='wholegrain-pasta'){
  result=wholegrainPastaPercent(ingredients);
 }else if(p.id==='pork-liver-pate'){
  result=porkLiverPatePercent(ingredients);
 }else if(p.id==='pasta-tomato'){
  result=pastaTomatoPercent(ingredients);
 }else if(p.id==='beans-in-tomato'&&components(ingredients).filter(part=>/bønn|bean/i.test(part)).length>1){
  result={fact:null,reason:'ambiguous-bean-components'};
 }else if(p.id==='ketchup'){
  result=tomatoInput(ingredients,description,clean(cross?.description),/^https:\/\/\S+$/i.test(primary?.primaryUrl??'')?clean(primary?.description):'');
  const puree=percent(ingredients,'tomatpur[eéè]|tomatpasta|tomatkonsentrat');
  if(puree.fact)base.context.push({name:'Deklarert tomatpuré/-konsentrat',value:puree.fact.value,unit:'%',evidence:puree.fact.evidence,note:'Konsentrasjon/tørrstoff er ukjent. Prosenten omregnes ikke til ferske tomater.'});
 }else{
  result=percent(ingredients,'(?:'+p.token+')',{allowSpeciesList:p.id==='fishcakes'});
  if(p.id==='fishcakes'&&!result.fact&&result.reason==='missing-declared-amount'){
   const fillet=percent(ingredients,'(?:fersk(?:e)?\\s+)?(?:fiske|hyse)filet');
   const trimmed=percent(ingredients,'renskåret\\s+(?:hvit\\s*[- ]?\\s*)?fisk');
   if(fillet.fact&&!trimmed.fact&&trimmed.reason==='missing-declared-amount'){result=fillet;p.basis='declared-fish-fillet-percent';p.label='Deklarert fiskefiletandel';}
   else if(trimmed.fact&&!fillet.fact&&fillet.reason==='missing-declared-amount'){result=trimmed;p.basis='declared-trimmed-fish-percent';p.label='Deklarert andel renskåret fisk';}
   else if(fillet.fact||trimmed.fact||fillet.reason!=='missing-declared-amount'||trimmed.reason!=='missing-declared-amount')result={fact:null,reason:'ambiguous-fish-content-basis'};
  }
  if(!result.fact&&result.reason==='missing-declared-amount'&&p.single?.test(ingredients))result={fact:{value:100,evidence:[{text:ingredients,field:'ingredients',interpretation:'Hele ingrediensdeklarasjonen består av én råvare.'}]},reason:null};
  if(p.id==='fruit-spread'&&!result.fact&&result.reason==='missing-declared-amount'){
   const re=new RegExp('(?:fremstilt|framstilt|laget)\\s+av\\s*'+decimal+'\\s*g\\s*(?:frukt(?:\\s+og\\s+bær)?|bær|'+p.fruit+')\\s*(?:per|pr\\.?)\\s*100\\s*g','gi'),found=[];
   for(const[field,text]of [['ingredients',ingredients],['primaryLabel.description',/^https:\/\/\S+$/i.test(primary?.primaryUrl??'')?clean(primary?.description):'']])for(const x of text.matchAll(re))found.push({value:number(x[1]),text:x[0],field});
   result=uniqueFact(found,1000);if(result.fact){p.basis='fruit-input-g-per-100g';p.unit='g/100 g';p.label='Frukt-/bærmengde brukt per 100 g';}
  }
 }
 if(!result.fact)return{...base,reasons:[result.reason,...(p.id==='ketchup'?['puree-percent-is-not-fresh-tomato-input']:[])]};
 const measurement={...result.fact,name:p.label,unit:p.unit,basis:p.basis,sourceUrl:['crispbread','fruit-muesli','wholegrain-bread'].includes(p.id)?product?.nutrition?.sourceUrl??null:product?.sourceUrl??null};
 measurement.evidence=measurement.evidence.map(e=>({...e,field:e.field==='ingredients'&&!product?.ingredients?'crossSourceLabel.ingredients':e.field,sourceUrl:e.field==='nutrition.per100.fiber'?product?.nutrition?.sourceUrl??null:e.field.startsWith('primaryLabel')?primary?.primaryUrl??null:e.field.startsWith('crossSourceLabel')||e.field==='ingredients'&&!product?.ingredients?cross?.sourceUrl??product?.sourceUrl??null:product?.sourceUrl??null}));
 return{...base,status:'scored',score:Math.round(Math.min(100,result.fact.value/p.target*100)*10)/10,comparisonKey:QUALITY_MODEL_VERSION+':'+p.id+(p.subtype?':'+p.subtype:'')+':'+p.basis,criterion:p.label,measurement,normalization:{target:p.target,unit:p.unit,formula:'min(100, deklarert mengde / målverdi × 100)'},reasons:[]};
}
