import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssortmentRepository} from '../src/assortment-repository.mjs';
import {createShoppingAssortment} from '../src/shopping-assortment.mjs';
const at='2026-11-11T12:00:00Z';
test('large catalogue transactions stay encrypted outside the household archive and survive restart/compaction',t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'family-assortment-repo-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));const options={dataDir,encryptionKey:Buffer.alloc(32,44)};
 let repo=createAssortmentRepository(options),householdSaves=0,api=createShoppingAssortment(repo.state,{persist:repo.save,save:()=>householdSaves++,config:{enabled:true},now:()=>new Date(at)});
 const input={fetchedAt:at,data:[{id:1,name:'Synthetic label not plaintext',store:{code:'MENY_NO'},current_price:{price:30,date:at}}]};api.receiveKassal(input);api.receiveKassal({...input,data:[{...input.data[0],current_price:{price:20,date:at}}]});assert.equal(householdSaves,0);
 const journal=join(dataDir,'assortment','transactions.enc.jsonl');assert.ok(!readFileSync(journal).includes(Buffer.from('Synthetic label')));
 repo=createAssortmentRepository(options);assert.equal(repo.state.revision,2);assert.equal(repo.state.products['kassal:MENY_NO:1'].prices[0].grossPackPrice,20);assert.equal(repo.state.products['kassal:MENY_NO:1'].priceHistory.length,2);
 repo.compact();assert.equal(readFileSync(journal).length,0);repo=createAssortmentRepository(options);assert.equal(repo.state.revision,2);assert.equal(repo.state.products['kassal:MENY_NO:1'].priceHistory.length,2);
 api=createShoppingAssortment(repo.state,{persist:repo.save,config:{enabled:true},now:()=>new Date(at)});api.receiveKassal({...input,data:[{...input.data[0],current_price:{price:19,date:at}}]});assert.equal(createAssortmentRepository(options).state.revision,3);
});
test('torn encrypted transactions are never silently ignored or reported as a complete catalogue',t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'family-assortment-torn-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));const options={dataDir,encryptionKey:Buffer.alloc(32,45)},repo=createAssortmentRepository(options),api=createShoppingAssortment(repo.state,{persist:repo.save,config:{enabled:true},now:()=>new Date(at)});
 api.receiveKassal({fetchedAt:at,data:[]});appendFileSync(join(dataDir,'assortment','transactions.enc.jsonl'),'unfinished');assert.throws(()=>createAssortmentRepository(options),/Incomplete assortment transaction/);
});

test('native categories, Oda placements and household associations retain their receipts after restart',async t=>{
 const {createSesumTaxonomy}=await import('../src/sesum-taxonomy.mjs'),dataDir=mkdtempSync(join(tmpdir(),'family-native-taxonomy-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));const options={dataDir,encryptionKey:Buffer.alloc(32,46)},repo=createAssortmentRepository(options),families=[{familyId:'duck',requirementsFingerprint:'synthetic-current-requirements',products:[]}],taxonomy=createSesumTaxonomy(repo.state,{persist:repo.save,now:()=>new Date(at),watchFamilies:()=>families});
 taxonomy.receive({categories:[{id:'284',name:'And',parentId:null}],fetchedAt:at});taxonomy.linkWatch({familyId:'duck',requirementsFingerprint:families[0].requirementsFingerprint,categoryId:'284',categoryFingerprint:taxonomy.definition('284').fingerprint,reviewed:true,evidence:'Actual household raw duck association to the source category And; no stock or product approval changes.'});
 const restored=createAssortmentRepository(options),again=createSesumTaxonomy(restored.state,{persist:restored.save,now:()=>new Date(at),watchFamilies:()=>families});assert.equal(again.watchLinks(families)[0].categoryId,'284');repo.compact();assert.equal(createAssortmentRepository(options).state.categoryWatchLinks.duck.categoryId,'284');
});
