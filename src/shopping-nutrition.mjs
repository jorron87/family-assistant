const rounded=value=>Math.round(value*10)/10;
const nutrients=['kcal','protein','fat','carbs'];
export function validateNutrition(input) {
  if(!input.productKey||!['g','ml'].includes(input.basis)||!input.sourceUrl||!input.evidence)throw Error('Næringsdata krever produkt, mengdegrunnlag og kildebelegg.');
  const link=new URL(input.sourceUrl);if(link.protocol!=='https:')throw Error('Næringskilden må bruke HTTPS.');
  const per100={};for(const field of nutrients){const n=input.per100?.[field];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>(field==='kcal'?950:100))throw Error('Ufullstendige eller ugyldige næringsdata.');per100[field]=n;}
  if(per100.protein+per100.fat+per100.carbs>101)throw Error('Makronæringsstoffene overstiger mengdegrunnlaget.');
  return {productKey:input.productKey,basis:input.basis,per100,sourceUrl:link.href,evidence:String(input.evidence).slice(0,1500),checkedAt:new Date().toISOString()};
}
export function purchaseNutrition(orders,records) {
  const totals={kcal:0,protein:0,fat:0,carbs:0},products=new Map(),missing=new Set();let foodSpend=0,coveredSpend=0,foodLines=0,coveredLines=0;
  for(const order of orders)for(const p of order.products){
    if(['Hus og hjem','Hygiene og skjønnhet','Baby og barn','Blomster og planter','Bursdag og fest'].includes(p.category))continue;
    foodSpend+=p.netTotal;foodLines++;
    const record=records[p.productKey];
    if(!record||!p.pack||!((p.pack.unit==='kg'&&record.basis==='g')||(p.pack.unit==='l'&&record.basis==='ml'))){missing.add(p.productKey);continue;}
    const factor=p.pack.amount*1000*p.quantity/100;coveredSpend+=p.netTotal;coveredLines++;
    const item=products.get(p.productKey)??{productKey:p.productKey,name:p.name,spent:0,protein:0};
    for(const field of nutrients)totals[field]+=record.per100[field]*factor;
    item.spent+=p.netTotal;item.protein+=record.per100.protein*factor;products.set(p.productKey,item);
  }
  const macroEnergy=totals.protein*4+totals.fat*9+totals.carbs*4;
  return {totals:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,rounded(v)])),energyShare:macroEnergy>0?{protein:rounded(totals.protein*4/macroEnergy*100),fat:rounded(totals.fat*9/macroEnergy*100),carbs:rounded(totals.carbs*4/macroEnergy*100)}:null,coverage:{foodLines,coveredLines,spendPct:foodSpend>0?rounded(coveredSpend/foodSpend*100):0,missingProductKeys:[...missing]},proteinCosts:[...products.values()].filter(p=>p.protein>0).map(p=>({...p,protein:rounded(p.protein),per100gProtein:rounded(p.spent/p.protein*100)})).sort((a,b)=>a.per100gProtein-b.per100gProtein),note:'Innkjøpte mengder med kildebelagte næringsdata. Kjøp andre steder, lagerendringer, matsvinn og hvem som spiser maten er ikke målt.'};
}
