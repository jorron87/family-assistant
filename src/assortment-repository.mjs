import {existsSync,mkdirSync,readFileSync,appendFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {encrypt,decrypt} from './crypto.mjs';

/** Large native catalogues must not enlarge/re-encrypt the household archive
 * on every receipt or household action. Append complete encrypted transactions;
 * a torn/invalid transaction fails closed, never disappears from coverage. */
export function createAssortmentRepository({dataDir,encryptionKey}){
 const directory=join(dataDir,'assortment'),journal=join(directory,'transactions.enc.jsonl'),snapshot=join(directory,'snapshot.enc');
 mkdirSync(directory,{recursive:true});
 const state=existsSync(snapshot)?JSON.parse(decrypt(readFileSync(snapshot),encryptionKey)):{version:1,products:{},groups:{},reviews:{},revision:0,reviewHistory:[]};
 function apply(transaction){
  if(transaction.revision<=state.revision)return;
  if(transaction.revision!==state.revision+1)throw Error('Assortment transaction gap; preserve the journal for recovery.');
  if(transaction.catalogueRevision!==undefined)state.catalogueRevision=transaction.catalogueRevision;
  for(const row of transaction.products??[])state.products[row.productKey]=row;
  for(const [id,group] of transaction.groups??[])state.groups[id]=group;
  for(const [key,review] of transaction.reviews??[])state.reviews[key]=review;
  state.categories??={};state.categoryPlacements??={};state.categoryPlacementHistory??=[];
  for(const [id,category] of transaction.categories??[])state.categories[id]=category;
  for(const [id,placement] of transaction.categoryPlacements??[])state.categoryPlacements[id]=placement;
  state.categoryWatchLinks??={};state.categoryWatchLinkHistory??=[];
  for(const [id,link] of transaction.categoryWatchLinks??[])state.categoryWatchLinks[id]=link;
  state.categoryWatchLinkHistory.push(...transaction.categoryWatchLinkHistory??[]);
  state.categoryPlacementHistory.push(...transaction.categoryPlacementHistory??[]);
  state.reviewHistory??=[];state.reviewHistory.push(...transaction.reviewHistory??[]);state.revision=transaction.revision;
 }
 if(existsSync(journal)){
  const bytes=readFileSync(journal,'utf8');if(bytes&&!bytes.endsWith('\n'))throw Error('Incomplete assortment transaction; preserve the journal for recovery.');
  for(const line of bytes.split('\n'))if(line){let transaction;try{transaction=JSON.parse(decrypt(Buffer.from(line,'base64'),encryptionKey));}catch{throw Error('Invalid assortment transaction; preserve the journal for recovery.');}apply(transaction);}
 }
 const save=transaction=>{
  if(transaction.revision!==state.revision)throw Error('Assortment repository revision mismatch.');
  appendFileSync(journal,encrypt(Buffer.from(JSON.stringify(transaction)),encryptionKey).toString('base64')+'\n');
 };
 function compact(){
  const temporary=snapshot+'.tmp';writeFileSync(temporary,encrypt(Buffer.from(JSON.stringify(state)),encryptionKey));renameSync(temporary,snapshot);
  // Snapshot revision makes old journal entries harmless if interrupted before
  // this atomic replacement. Later records must still form a contiguous chain.
  const pending=journal+'.tmp';writeFileSync(pending,'');renameSync(pending,journal);return {revision:state.revision,products:Object.keys(state.products).length};
 }
 return {state,save,compact};
}
