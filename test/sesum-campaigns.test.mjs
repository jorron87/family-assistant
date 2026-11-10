import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignFingerprint,offerTermsFingerprint,validateCampaignOffer} from '../src/sesum-campaigns.mjs';

const NOW='2026-11-10T12:00:00Z',READ='2026-11-10T11:00:00Z';
function fixture(){return {
  campaign:{sourceKey:'sesum:KIWI:100',sourceFingerprint:'a'.repeat(64),source:{store:'KIWI',id:'100'},packAmount:1,unit:'l',receipt:{price:12,isPromo:false,source:'actual_paid_receipt',observedAt:'2026-11-09T10:00:00Z',promotion:{id:'synthetic-week',price:5,valid_from:'2026-11-09T00:00:00Z',valid_until:'2026-11-16T00:00:00Z'}}},
  offer:{storeId:'near',watchId:'milk',externalId:'synthetic-milk',name:'Synthetic milk 1 l',price:5,packAmount:1,unit:'l',validFrom:'2026-11-09',validTo:'2026-11-15',observedAt:READ,sourceUrl:'https://shop.example.test/flyer',memberOnly:false,maxPacks:null,bundlePacks:1,conditions:'',bestBefore:null,priceIncludesVat:true,quotedPriceIncludesVat:true},
  chainCode:'KIWI',conditionsVerified:true,
  termsEvidence:{price:'The primary flyer announces 5 kroner per one-litre carton.',period:'The primary flyer explicitly announces 9 through 15 November.',membership:'The actual primary terms state that membership is not required.',customerLimit:'The complete primary purchase terms were read; no customer cap is announced.',bundle:'The actual announced price is for one carton; no multibuy is required.',conditions:'The complete primary conditions were read; no extra conditions apply.'},
  sourceReceipts:[{url:'https://cdn.example.test/primary-flyer',observedAt:READ,evidence:'Read the complete primary flyer price, carton, announced days and purchase conditions.'}],now:new Date(NOW)
};}

test('campaign fingerprint binds all promotion fields and price while excluding transport and receipt times',()=>{
  const f=fixture(),first=campaignFingerprint(f.campaign);
  const same=structuredClone(f.campaign);same.receipt.observedAt=NOW;same.fetchedAt=NOW;same.reviewedAt=NOW;same.receipt.promotion={valid_until:same.receipt.promotion.valid_until,price:5,id:'synthetic-week',valid_from:same.receipt.promotion.valid_from};
  assert.equal(campaignFingerprint(same),first);
  for(const change of [c=>{c.receipt.price=13;},c=>{c.receipt.isPromo=true;},c=>{c.receipt.source='another_actual_price_source';},c=>{c.receipt.promotion.unknownOpaqueField={description:'A new material condition',nested:[1,false,null]};},c=>{c.receipt.promotion.valid_until='2026-11-17T00:00:00Z';},c=>{c.packAmount=.5;},c=>{c.sourceFingerprint='b'.repeat(64);}]){
    const candidate=structuredClone(f.campaign);change(candidate);assert.notEqual(campaignFingerprint(candidate),first);
  }
});

test('ordinary offer terms fingerprint excludes observation and evidence but binds every actionable restriction',()=>{
  const f=fixture(),first=offerTermsFingerprint(f.offer,f.chainCode),same={...f.offer,observedAt:NOW,evidence:'New review wording',comparisonNote:'Different prose'};
  assert.equal(offerTermsFingerprint(same,f.chainCode),first);
  for(const [key,value] of Object.entries({storeId:'other',watchId:'other-family',externalId:'another-offer',name:'Changed name',price:4,packAmount:.5,unit:'kg',validFrom:'2026-11-10',validTo:'2026-11-14',memberOnly:true,maxPacks:2,bundlePacks:2,conditions:'Maximum two cartons',bestBefore:'2026-11-20',priceIncludesVat:false,quotedPriceIncludesVat:false,priceBeforeVat:4,vatRate:.15,sourceUrl:'https://shop.example.test/another-flyer'}))assert.notEqual(offerTermsFingerprint({...f.offer,[key]:value},f.chainCode),first,key);
  assert.notEqual(offerTermsFingerprint(f.offer,'COOP_EXTRA'),first);
});

test('an independently verified campaign price does not become equal to an unrelated paid receipt',()=>{
  const f=fixture(),proof=validateCampaignOffer(f);
  assert.equal(f.campaign.receipt.price,12);assert.equal(f.offer.price,5);assert.equal(proof.campaignFingerprint,campaignFingerprint(f.campaign));
  assert.equal(proof.offerTermsFingerprint,offerTermsFingerprint(f.offer,f.chainCode));assert.equal(proof.latestPrimaryReadAt,new Date(READ).toISOString());assert.equal(proof.reviewedAt,new Date(NOW).toISOString());
  assert.equal(proof.sourceReceipts[0].url,'https://cdn.example.test/primary-flyer');assert.deepEqual(proof.termsEvidence,f.termsEvidence);
});

test('exclusive UTC expiry accepts the primary-announced 9 through 15 November but never all of 16 November',()=>{
  const f=fixture();assert.doesNotThrow(()=>validateCampaignOffer(f));
  f.offer.validTo='2026-11-16';assert.throws(()=>validateCampaignOffer(f),/period/);
  f.offer.validTo='2026-11-15';f.offer.validFrom='2026-11-08';assert.throws(()=>validateCampaignOffer(f),/period/);
});

test('every supplied source date alias is checked and contradictory days are unresolved',()=>{
  const f=fixture();f.campaign.receipt.promotion.validFrom='2026-11-09';f.campaign.receipt.promotion.endDate='2026-11-15';assert.doesNotThrow(()=>validateCampaignOffer(f));
  f.campaign.receipt.promotion.validTo='2026-11-16';assert.throws(()=>validateCampaignOffer(f),/Contradictory campaign end/);
  delete f.campaign.receipt.promotion.validTo;f.campaign.receipt.promotion.start_date='2026-11-10';assert.throws(()=>validateCampaignOffer(f),/Contradictory campaign start/);
  delete f.campaign.receipt.promotion.start_date;f.campaign.receipt.promotion.ends_at='not a date';assert.throws(()=>validateCampaignOffer(f),/ends_at/);
});

test('Oslo full-day expiry remains conservative across the autumn DST transition',()=>{
  const f=fixture();f.now=new Date('2026-10-24T12:00:00Z');f.sourceReceipts[0].observedAt=f.offer.observedAt='2026-10-24T11:00:00Z';
  f.offer.validFrom='2026-10-23';f.offer.validTo='2026-10-25';f.campaign.receipt.promotion.valid_from='2026-10-23T00:00:00Z';f.campaign.receipt.promotion.valid_until='2026-10-25T23:00:00Z';
  assert.doesNotThrow(()=>validateCampaignOffer(f));
  f.campaign.receipt.promotion.valid_until='2026-10-25T22:00:00Z';assert.throws(()=>validateCampaignOffer(f),/period/);
});

test('identity, matching package and a source flag never replace six concrete condition decisions and a fresh primary read',()=>{
  for(const missing of ['price','period','membership','customerLimit','bundle','conditions']){const f=fixture();delete f.termsEvidence[missing];assert.throws(()=>validateCampaignOffer(f),/evidence/);}
  for(const value of [false,undefined,'true']){const f=fixture();f.conditionsVerified=value;assert.throws(()=>validateCampaignOffer(f),/verification/);}
  for(const receipts of [[],[{url:'https://www.sesum.no/produkt/100-synthetic',observedAt:READ,evidence:'Only the aggregator was read.'}],[{url:'https://www.sesum.no./produkt/100-synthetic',observedAt:READ,evidence:'The same aggregator with a trailing DNS dot.'}],[{url:'http://shop.example.test/flyer',observedAt:READ,evidence:'An insecure source.'}],[{url:'https://user:password@shop.example.test/flyer',observedAt:READ,evidence:'A credential-bearing source.'}]]){const f=fixture();f.sourceReceipts=receipts;assert.throws(()=>validateCampaignOffer(f),/source|receipt|HTTPS|primary/i);}
});

test('unknown source terms can only be supplied by the explicit primary review, never a refreshed fetch timestamp',()=>{
  const f=fixture();f.campaign.receipt.promotion={};f.campaign.receipt.price=99;assert.doesNotThrow(()=>validateCampaignOffer(f));
  f.sourceReceipts[0].observedAt='2026-11-08T10:00:00Z';f.campaign.fetchedAt=NOW;assert.throws(()=>validateCampaignOffer(f),/48 hours/);
  f.sourceReceipts[0].observedAt='2026-11-10T12:00:01Z';assert.throws(()=>validateCampaignOffer(f),/past/);
  f.sourceReceipts[0].observedAt='2026-11-10T10:59:59Z';assert.throws(()=>validateCampaignOffer(f),/newer than/);
});

test('exact chain, canonical package, unit and gross package price are required',()=>{
  for(const change of [f=>{f.chainCode='COOP_EXTRA';},f=>{f.campaign.source.store='COOP_NO';},f=>{f.offer.packAmount=.5;},f=>{f.offer.unit='kg';},f=>{f.offer.priceIncludesVat=false;},f=>{f.offer.price=6;}]){const f=fixture();change(f);assert.throws(()=>validateCampaignOffer(f));}
  const rounded=fixture();rounded.campaign.packAmount=.39;rounded.offer.packAmount=.39000000000000001;assert.doesNotThrow(()=>validateCampaignOffer(rounded));
});

test('known membership, customer limit and free-text restrictions cannot be weakened',()=>{
  const f=fixture();Object.assign(f.campaign.receipt.promotion,{member_only:true,customer_limit:4,conditions:'Requires membership; maximum four per customer.'});
  assert.throws(()=>validateCampaignOffer(f),/membership/);
  f.offer.memberOnly=true;f.offer.maxPacks=5;f.offer.conditions='Requires membership; maximum five.';assert.throws(()=>validateCampaignOffer(f),/limits/);
  f.offer.maxPacks=2;f.offer.conditions='Requires membership; maximum two.';assert.doesNotThrow(()=>validateCampaignOffer(f),'a stricter documented offer cap does not weaken the source limit');
  f.offer.conditions='';assert.throws(()=>validateCampaignOffer(f),/restrictions/);
  f.offer.conditions='Membership and two-carton cap.';f.campaign.receipt.promotion.memberOnly=false;assert.throws(()=>validateCampaignOffer(f),/Contradictory campaign membership/);
});

test('a documented multibuy constrains required pack count and effective gross package price',()=>{
  const f=fixture();Object.assign(f.campaign.receipt.promotion,{multi_buy_quantity:2,multi_buy_price:10});f.offer.bundlePacks=2;f.offer.conditions='Two cartons must be bought together.';
  assert.doesNotThrow(()=>validateCampaignOffer(f));
  f.offer.bundlePacks=1;assert.throws(()=>validateCampaignOffer(f),/bundle quantity/);
  f.offer.bundlePacks=2;delete f.campaign.receipt.promotion.price;f.offer.price=6;assert.throws(()=>validateCampaignOffer(f),/campaign total/);
  f.offer.price=5;f.campaign.receipt.promotion.quantity=3;assert.throws(()=>validateCampaignOffer(f),/Contradictory campaign bundle/);
  delete f.campaign.receipt.promotion.quantity;f.campaign.receipt.promotion.multi_buy_pay_for=3;assert.throws(()=>validateCampaignOffer(f),/pay-for/);
});

test('malformed known facts, expired offers and oversized evidence remain blocked',()=>{
  for(const change of [f=>{f.campaign.receipt.promotion.customerLimit='Read unknown terms';},f=>{f.campaign.receipt.promotion.memberOnly='true';},f=>{f.campaign.receipt.promotion.multi_buy_quantity=1.5;},f=>{f.campaign.receipt.promotion.valid_until='2026-11-31T00:00:00Z';},f=>{f.offer.validTo='2026-11-09';},f=>{f.termsEvidence.period='x'.repeat(4001);},f=>{f.offer.maxPacks=undefined;},f=>{f.offer.bundlePacks=2;f.offer.maxPacks=1;}]){const f=fixture();change(f);assert.throws(()=>validateCampaignOffer(f));}
});

test('a noncampaign receipt is not turned into a campaign by manual review alone',()=>{
  const f=fixture();f.campaign.receipt.promotion=null;f.campaign.receipt.isPromo=false;
  assert.throws(()=>validateCampaignOffer(f),/no current campaign/);
});

function lastSecondFixture({day='2026-11-15',end='2026-11-15T22:59:59Z',from='2026-11-09'}={}){
  const f=fixture(),read=day+'T11:00:00Z';
  f.now=new Date(day+'T12:00:00Z');f.offer.observedAt=read;f.sourceReceipts[0].observedAt=read;f.campaign.receipt.observedAt=read;
  f.offer.validFrom=from;f.offer.validTo=day;f.campaign.receipt.promotion.valid_from=from+'T00:00:00Z';f.campaign.receipt.promotion.valid_until=end;
  f.termsEvidence.period='Read the actual primary announced inclusive calendar days '+from+' through '+day+', including the final local day.';
  f.inclusiveEndOfDayVerified=true;return f;
}

test('a separately verified final local second permits the announced winter final day without changing the default exclusive rule',()=>{
  const f=lastSecondFixture();delete f.inclusiveEndOfDayVerified;
  assert.throws(()=>validateCampaignOffer(f),/period/,'23:59:59 is still exclusive when the explicit review is omitted');
  f.inclusiveEndOfDayVerified=true;const proof=validateCampaignOffer(f);assert.equal(proof.inclusiveEndOfDayVerified,true);assert.equal(f.campaign.receipt.promotion.valid_until,'2026-11-15T22:59:59Z','validation must preserve the actual raw source timestamp');
  f.offer.validTo='2026-11-16';assert.throws(()=>validateCampaignOffer(f),/period/,'the explicit review never adds a second advertised calendar day');
});

test('the verified last second follows Oslo summer time and both DST transition days',()=>{
  const cases=[
    {day:'2026-07-15',from:'2026-07-13',end:'2026-07-15T21:59:59Z',local:'2026-07-15T23:59:59+02:00'},
    {day:'2026-03-29',from:'2026-03-23',end:'2026-03-29T21:59:59Z',local:'2026-03-29T23:59:59+02:00'},
    {day:'2026-10-25',from:'2026-10-19',end:'2026-10-25T22:59:59Z',local:'2026-10-25T23:59:59+01:00'}
  ];
  for(const c of cases){
    const f=lastSecondFixture(c);f.campaign.receipt.promotion.endsAt=c.local;assert.doesNotThrow(()=>validateCampaignOffer(f),c.day+' is one whole advertised local day even when its length changes');
    delete f.inclusiveEndOfDayVerified;assert.throws(()=>validateCampaignOffer(f),/period/,c.day+' retains the default conservative exclusive interpretation');
  }
});

test('equivalent last-second aliases and raw all-zero fractions agree, while different or non-final aliases remain unresolved',()=>{
  for(const suffix of ['Z','.0Z','.000Z','.000000Z']){
    const f=lastSecondFixture({end:'2026-11-15T22:59:59'+suffix});f.campaign.receipt.promotion.endsAt='2026-11-15T23:59:59.000000+01:00';f.campaign.receipt.promotion.endDate='2026-11-15';assert.doesNotThrow(()=>validateCampaignOffer(f),suffix);
  }
  for(const conflicting of ['2026-11-14','2026-11-16','2026-11-14T22:59:59Z','2026-11-16T00:00:00+01:00','2026-11-15T12:00:00Z']){
    const f=lastSecondFixture();f.campaign.receipt.promotion.endsAt=conflicting;assert.throws(()=>validateCampaignOffer(f),conflicting+' cannot be hidden behind another valid end alias');
  }
});

test('only literal true with at least one actual timestamped campaign end can supply the inclusive review',()=>{
  for(const value of [false,'true','false',null,0,1,{},[]]){const f=lastSecondFixture();f.inclusiveEndOfDayVerified=value;assert.throws(()=>validateCampaignOffer(f),'invalid flag '+JSON.stringify(value));}
  for(const value of [undefined,null,'','2026-11-15']){
    const f=lastSecondFixture();if(value===undefined)delete f.campaign.receipt.promotion.valid_until;else f.campaign.receipt.promotion.valid_until=value;
    assert.throws(()=>validateCampaignOffer(f),'an absent, empty or date-only end does not prove an actual last second');
  }
  const ordinary=lastSecondFixture();delete ordinary.inclusiveEndOfDayVerified;ordinary.campaign.receipt.promotion.valid_until='2026-11-15';assert.doesNotThrow(()=>validateCampaignOffer(ordinary),'omitting the new optional review preserves the ordinary date-only contract');
});

test('raw submillisecond fractions and times before the exact final local second never round into a whole final day',()=>{
  for(const end of ['2026-11-15T22:59:59.001Z','2026-11-15T22:59:59.0001Z','2026-11-15T22:59:59.000001Z','2026-11-15T23:59:59.0000001+01:00','2026-11-15T22:59:58Z','2026-11-15T12:00:00Z','2026-11-15T00:00:00Z','2026-11-16T00:00:00+01:00']){
    const f=lastSecondFixture({end});assert.throws(()=>validateCampaignOffer(f),end);
  }
  const midnight=fixture();assert.doesNotThrow(()=>validateCampaignOffer(midnight),'the existing exclusive midnight receipt still supports only its actually bounded previous final day');
  midnight.inclusiveEndOfDayVerified=true;assert.throws(()=>validateCampaignOffer(midnight),'midnight cannot be relabelled as a final-second receipt');
});

test('verifying the final second never replaces the six primary terms or an actual fresh non-Sesum read',()=>{
  for(const field of ['price','period','membership','customerLimit','bundle','conditions']){const f=lastSecondFixture();delete f.termsEvidence[field];assert.throws(()=>validateCampaignOffer(f),field+' still needs actual primary evidence');}
  const unverified=lastSecondFixture();unverified.conditionsVerified=false;assert.throws(()=>validateCampaignOffer(unverified));
  const stale=lastSecondFixture();stale.sourceReceipts[0].observedAt='2026-11-12T11:00:00Z';assert.throws(()=>validateCampaignOffer(stale),/48 hours/);
  const aggregator=lastSecondFixture();aggregator.sourceReceipts[0].url='https://www.sesum.no/produkt/100-synthetic';assert.throws(()=>validateCampaignOffer(aggregator),/primary/);
});
