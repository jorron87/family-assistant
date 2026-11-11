import test from 'node:test';
import assert from 'node:assert/strict';
import '../config/vigilo-keepalive/sesum-core.js';

const core = globalThis.FamilienSesumCore;
const productUrl = 'https://www.sesum.no/produkt/101-yoghurt-naturell';
const searchUrl = 'https://www.sesum.no/sok?q=yoghurt';
const product = { id: 101, name: 'Yoghurt naturell – økologisk', brand: 'Eksempel', vendor: null,
  ean: ['7030000000101'], weight: 850, weightUnit: 'g', soldByWeight: false };
const price = { storeId: 2, storeCode: 'KIWI', price: 49.4, unitPrice: 49.4,
  source: 'receipt_realtime', observedAt: '2026-11-09T12:30:00Z', isPromo: false, promotion: null };
const html = (value, content = '') => '<html><body>' + content + '<script>self.__next_f.push(' +
  JSON.stringify([1, '0:' + JSON.stringify(value) + '\n']) + ')</script></body></html>';

test('actual native category nodes retain their complete IDs/names/parents and own breadcrumbs never use sidebar hints',()=>{
 const tree={id:46,name:'Kylling og fjærkre',children:[{id:283,name:'And',children:[{id:284,name:'And',children:[]},{id:2112,name:'Andefett',children:[]}]}]},links=[46,283,284,2112].map(id=>`<a href="/kategori/${id}-synthetic">Source category</a>`).join('');
 const parsed=core.parseCatalogue(html(tree,'<h1>Alle kategorier</h1><p>4 kategorier med varer</p>'+links),'https://www.sesum.no/kategori');assert.equal(parsed.ok,true);assert.equal(parsed.categories.length,4);assert.equal(parsed.categories.find(c=>c.id==='284').parentId,'283');assert.equal(parsed.categories.find(c=>c.id==='284').name,'And');
 const breadcrumbs='<nav aria-label="Brødsmuler"><a href="/?kategori=46">Kylling og fjærkre</a><a href="/?kategori=283">And</a><a href="/?kategori=284">And</a></nav><aside><a href="/?kategori=99">Wrong unrelated sidebar</a></aside>';
 const own=core.parseProduct(html({product,prices:[price]},breadcrumbs),productUrl);assert.equal(own.ok,true);assert.deepEqual(own.product.categoryPathIds,['46','283','284']);
});

test('own product prices remain separate from site similarity suggestions and suspect unit prices', () => {
  const result = core.parseProduct(html(['$', 'section', null, { product, prices: [price], tilsvarende: [
    { product: { ...product, id: 202, name: 'Annen variant' }, prices: [{ ...price, price: 9.9 }] }
  ] }]), productUrl);
  assert.equal(result.ok, true);
  assert.equal(result.product.name, product.name);
  assert.deepEqual(result.product.ean, product.ean);
  assert.equal(result.prices.length, 1);
  assert.equal(result.prices[0].price, 49.4);
  assert.equal(result.prices[0].rawUnitPrice, 49.4);
  assert.equal('unitPrice' in result.prices[0], false);
  assert.deepEqual(result.candidates, [{ id: 202, name: 'Annen variant', sourceUrl: null, reason: 'site_similarity_not_reviewed' }]);
});

test('RSC fragments and references are decoded with JSON only; arbitrary page scripts never execute', () => {
  const stream = '1:' + JSON.stringify(product) + '\n2:' + JSON.stringify([price]) + '\n0:' +
    JSON.stringify(['$', 'section', null, { product: '$1', prices: '$2' }]) + '\n';
  const parts = [stream.slice(0, 47), stream.slice(47)];
  const input = '<script>globalThis.sesumExecuted = true;</script>' + parts.map((part) =>
    '<script>self.__next_f.push(' + JSON.stringify([1, part]) + ')</script>').join('');
  assert.equal(core.parseProduct(input, productUrl).ok, true);
  assert.equal(globalThis.sesumExecuted, undefined);
});

test('promotion evidence keeps dates, multibuy and limits while omitting unrelated account fields', () => {
  const promotion = { valid_from: '2026-11-09', valid_until: '2026-11-15', multi_buy_quantity: 3,
    multi_buy_pay_for: 2, member_only: true, member_program: 'Example membership', customer_limit: 6,
    accessToken: 'unrelated-secret', profile: { private: true } };
  const parsed = core.parseProduct(html({ product, prices: [{ ...price, isPromo: true, promotion }] }), productUrl);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prices[0].promotion.valid_until, promotion.valid_until);
  assert.equal(parsed.prices[0].promotion.customer_limit, 6);
  assert.equal(parsed.prices[0].promotion.multi_buy_pay_for, 2);
  assert.equal(JSON.stringify(parsed).includes('unrelated-secret'), false);
  assert.equal('profile' in parsed.prices[0].promotion, false);
});

test('null EAN remains unknown; malformed packages or receipts fail closed', () => {
  assert.equal(core.parseProduct(html({ product: { ...product, ean: null }, prices: [price] }), productUrl).product.ean, null);
  for (const invalid of [{ ...product, ean: ['bad code'] }, { ...product, weight: '850' }]) {
    assert.equal(core.parseProduct(html({ product: invalid, prices: [price] }), productUrl).ok, false);
  }
  for (const invalid of [{ ...price, observedAt: null }, { ...price, observedAt: '2026-11-09T12:30:00' }, { ...price, source: '' }, { ...price, price: -1 }]) {
    const result = core.parseProduct(html({ product, prices: [invalid] }), productUrl);
    assert.equal(result.ok, false);
    assert.deepEqual(result.prices, []);
  }
});

test('short source catalogue codes stay separate from EANs without losing own prices or variable-weight status', () => {
  const source = { ...product, ean: ['7030000000101', '4073', '12', '4073'], soldByWeight: true };
  const parsed = core.parseProduct(html({ product: source, prices: [price] }), productUrl);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.product.ean, ['7030000000101']);
  assert.deepEqual(parsed.product.nonEanCodes, ['4073', '12']);
  assert.equal(parsed.product.soldByWeight, true, 'parsing a price never establishes a fixed package');
  assert.equal(parsed.prices[0].price, price.price);
  assert.equal(parsed.prices[0].observedAt, price.observedAt);
  const onlyShort = core.parseProduct(html({ product: { ...source, ean: ['4073'] }, prices: [price] }), productUrl);
  assert.equal(onlyShort.ok, true);assert.equal(onlyShort.product.ean, null);assert.deepEqual(onlyShort.product.nonEanCodes, ['4073']);
  for (const ean of [['bad code'], [''], ['https://example.test/code'], ['4073', null], [4073]]) {
    const failed = core.parseProduct(html({ product: { ...source, ean }, prices: [price] }), productUrl);
    assert.equal(failed.ok, false);assert.deepEqual(failed.prices, [], 'malformed fields do not certify any own price');
  }
});

test('opaque source identifiers in an EAN field remain distinct from actual barcodes',()=>{
  const parsed=core.parseProduct(html({product:{...product,ean:['7030000000101','KIWI-synthetic-64stk','40x3']},prices:[price]}),productUrl);
  assert.equal(parsed.ok,true);assert.deepEqual(parsed.product.ean,['7030000000101']);
  assert.deepEqual(parsed.product.nonEanCodes,['KIWI-synthetic-64stk','40x3']);
  assert.equal(parsed.prices[0].price,price.price);assert.equal(parsed.prices[0].observedAt,price.observedAt);
});

const variableProduct = { ...product, name: 'Synthetic loose product', weight: null, weightUnit: null, soldByWeight: true };
const ownRow = (label, { id = 2, chain = id === 9 ? 'REMA 1000' : 'KIWI', control = 'kjederad-' + id, rowClass = 'desktop_kjederadHode__synthetic', priceClass = 'desktop_butikkpris__synthetic', attrs = '', buttonAttrs = '', content = '' } = {}) =>
  `<div class="${rowClass}" ${attrs}><button data-store="${id}" aria-controls="${control}" aria-label="Vis prisgrunnlag og prishistorikk for ${chain}" ${buttonAttrs}><span class="${priceClass}">${label}</span></button>${content}</div>`;
const priceWidget = (content, heading = 'Priser denne uken') => `<section class="desktop_prices__synthetic"><section class="prisseksjoner_seksjon__synthetic"><h3>${heading}</h3>${content}</section></section>`;
const variablePage = (content, prices = [price], details = variableProduct) => core.parseProduct(html({ product: details, prices }, priceWidget(content)), productUrl);

test('an own main chain row preserves explicit kg/l labels with exact product, store and actual receipt provenance', () => {
  const observedAt = '2026-11-09T12:30:00.123456+00:00';
  for (const [label, amount, unit] of [['49,40 kr/kg', 49.4, 'kg'], ['49,4 kr/l', 49.4, 'l'],
    ['1&nbsp;234,50 kr/kg', 1234.5, 'kg'], ['1.234,50 NOK/l', 1234.5, 'l'], ['1&#8239;234 kr/kg', 1234, 'kg']]) {
    const quote = { ...price, price: amount, unitPrice: 999, observedAt, isPromo: true, promotion: { member_only: true } };
    const result = variablePage(ownRow(label), [quote]);
    assert.equal(result.ok, true, label);
    assert.deepEqual(result.prices[0].unitPriceBasis, { kind: 'own-chain-row-label-v1', productId: '101', sourceUrl: productUrl,
      storeId: '2', storeCode: 'KIWI', rowControl: 'kjederad-2', label: label.replace(/&nbsp;|&#8239;/g, ' '), amount, unit, observedAt, source: quote.source });
    assert.equal(result.prices[0].price, amount);
    assert.equal(result.prices[0].rawUnitPrice, 999, 'suspect numeric unitPrice is preserved without supplying the basis');
    assert.equal(result.prices[0].observedAt, observedAt, 'submillisecond source timestamp is not rewritten to fetch time');
    assert.deepEqual(result.prices[0].promotion, { member_only: true });
    assert.equal(result.prices[0].isPromo, true);
    assert.equal('directUnitVerified' in result.prices[0], false, 'capturing a label is not a review approval');
    assert.equal(result.product.weight, null);
  }
});

test('raw unit numbers, names, hero text, history, related cards and script strings never supply own unit proof', () => {
  const named = { ...variableProduct, name: 'Synthetic pr kg – 49,40 kr/kg' };
  const source = { ...price, unitPrice: 49.4 };
  const unrelated = '<h1>49,40 kr/kg</h1><p>Løsvekt</p><span class="desktop_butikkpris__synthetic">49,40 kr/kg</span>' +
    ownRow('49,40 kr/kg', { rowClass: 'related_kjederadHode__synthetic' }) +
    '<div id="kjederad-2"><span class="desktop_butikkpris__synthetic">49,40 kr/kg</span></div>' +
    '<script>globalThis.sesumUnitExecuted = true; const unrelated = ' + JSON.stringify(ownRow('49,40 kr/kg')) + ';</script>' +
    '<template>' + ownRow('49,40 kr/kg') + '</template>';
  const result = variablePage(unrelated, [source], named);
  assert.equal(result.ok, true);
  assert.equal(result.prices[0].unitPriceBasis, undefined);
  assert.equal(result.prices[0].price, source.price);
  assert.equal(globalThis.sesumUnitExecuted, undefined);
  assert.equal(variablePage('', [source], named).prices[0].unitPriceBasis, undefined, 'RSC JSON alone has no displayed own basis');
  const embedded = '0:' + JSON.stringify({ product: { ...named, description: ownRow('49,40 kr/kg') }, prices: [source] }) + '\n';
  assert.equal(core.parseProduct(embedded, productUrl).prices[0].unitPriceBasis, undefined, 'markup inside a JSON-only response is not delivered HTML');
  const fixed = variablePage(ownRow('49,40 kr/kg'), [source], product);
  assert.equal(fixed.prices[0].unitPriceBasis, undefined, 'the unchanged fixed-package contract is not reclassified');
});

test('a main row must match its exact store control and literal amount/unit without discarding the raw quote', () => {
  const invalidRows = [
    ownRow('49,40 kr/kg', { id: 9 }), ownRow('49,40 kr/kg', { control: 'kjederad-9' }), ownRow('49,40 kr/kg', { chain: 'REMA 1000' }),
    ownRow('49,40 kr/kg', { buttonAttrs: 'hidden' }), ownRow('49,40 kr/kg', { attrs: 'hidden' }),
    ownRow('49,40 kr/kg', { attrs: 'aria-hidden="true"' }), ownRow('49,40 kr/kg', { attrs: 'style="display:none"' }),
    ownRow('49,40 kr/kg', { priceClass: 'history_butikkpris__synthetic' }),
    ownRow('49,40 kr/kg').replace('Vis prisgrunnlag og prishistorikk for KIWI', 'Related product price'),
    ownRow('49,40 kr/kg').replace('</span>', ''),
    ...['49,40', '49.40 kr/kg', '49,400 kr/kg', '1 23,40 kr/kg', '1,234.50 kr/kg', '49,40 kr/stk', '49,40 EUR/kg', '0 kr/kg', '-49,40 kr/kg', '49,40 kr/kg medlem', '49,41 kr/kg'].map(label => ownRow(label))
  ];
  for (const content of invalidRows) {
    const result = variablePage(content);
    assert.equal(result.ok, true, content);
    assert.equal(result.prices[0].unitPriceBasis, undefined, content);
    assert.equal(result.prices[0].price, price.price);
    assert.equal(result.prices[0].observedAt, price.observedAt);
  }
  assert.equal(variablePage(ownRow('49,40 kr/kg'), [{ ...price, price: 49.404 }]).prices[0].unitPriceBasis.amount, 49.4, 'only normal displayed half-øre rounding is allowed');
});

test('duplicate and nested main-row ambiguity holds only the affected chain while identical labels agree', () => {
  const second = { ...price, storeId: 9, storeCode: 'REMA_1000', price: 65 };
  const validSecond = ownRow('65,00 kr/kg', { id: 9 });
  for (const badFirst of [ownRow('49,40 kr/kg') + ownRow('49,40 kr/l'),
    ownRow('49,40 kr/kg') + ownRow('49,40'),
    ownRow('49,40 kr/kg', { content: '<button data-store="2" aria-controls="kjederad-2">Other</button>' }),
    ownRow('49,40 kr/kg', { content: ownRow('49,40 kr/kg') })]) {
    const result = variablePage(badFirst + validSecond, [price, second]);
    assert.equal(result.ok, true);
    assert.equal(result.prices[0].unitPriceBasis, undefined);
    assert.equal(result.prices[1].unitPriceBasis.amount, 65);
    assert.equal(result.prices[1].unitPriceBasis.storeCode, 'REMA_1000');
  }
  const identical = variablePage(ownRow('49,40 kr/kg') + ownRow('49,4 kr/kg'));
  assert.equal(identical.prices[0].unitPriceBasis.amount, 49.4);
});

test('identical chain-row markup outside the own main price widget or inside history/related contexts cannot supply a basis', () => {
  const raw = ownRow('49,40 kr/kg');
  const unproven = [raw, '<section class="desktop_prices__synthetic">' + raw + '</section>',
    priceWidget(raw, 'Tilsvarende varer'), priceWidget('<section class="desktop_prices__nested">' + raw + '</section>'),
    priceWidget('<div id="kjederad-2">' + raw + '</div>'),
    priceWidget('<section aria-label="Prishistorikk">' + raw + '</section>'),
    priceWidget('<section aria-label="Relaterte produkter">' + raw + '</section>'),
    '<section aria-label="Related products">' + priceWidget(raw) + '</section>'];
  for (const content of unproven) {
    const result = core.parseProduct(html({ product: variableProduct, prices: [price] }, content), productUrl);
    assert.equal(result.ok, true);
    assert.equal(result.prices[0].unitPriceBasis, undefined, content);
    assert.equal(result.prices[0].observedAt, price.observedAt);
  }
  const ownWithUnrelated = core.parseProduct(html({ product: variableProduct, prices: [price] },
    priceWidget(raw + '<div id="kjederad-2"><h3>Historiske priser</h3>' + ownRow('2,00 kr/kg') + '</div>') + ownRow('1,00 kr/kg') + '<section aria-label="Prishistorikk">' + priceWidget(ownRow('2,00 kr/kg')) + '</section>'), productUrl);
  assert.equal(ownWithUnrelated.prices[0].unitPriceBasis.amount, 49.4, 'unrelated rows cannot conflict with the genuine main widget');
  const olderSection = core.parseProduct(html({ product: variableProduct, prices: [price] }, priceWidget(raw, 'Eldre priser')), productUrl);
  assert.equal(olderSection.prices[0].unitPriceBasis.amount, 49.4, 'weekly UI labels do not replace actual receipt freshness');
});

test('unexpected or conflicting own product schema cannot select a cheap unrelated row', () => {
  assert.equal(core.parseProduct(html({ product: { ...product, id: 999 }, prices: [price] }), productUrl).ok, false);
  assert.equal(core.parseProduct(html([{ product, prices: [price] }, { product, prices: [{ ...price, price: 1 }] }]), productUrl).ok, false);
  assert.equal(core.parseProduct(html({ product, prices: [price, { ...price, price: 1 }] }), productUrl).ok, false);
  assert.equal(core.parseProduct('<html>Logg inn</html>', productUrl).ok, false);
  assert.equal(core.parseProduct(html({ product, prices: [price] }), 'https://example.test/produkt/101').ok, false);
});

test('search follows actual same-query next links and never calls a missing link complete', () => {
  const links = '<a href="/produkt/101-yoghurt">Yoghurt økologisk</a>' +
    '<a rel="next" href="/sok?q=yoghurt&amp;side=2">Neste side</a>' +
    '<a rel="next" href="https://evil.example/sok?q=yoghurt">Neste</a>';
  const result = core.parseSearch(html({ pagination: { total: 2, hasMore: true } }, links), searchUrl);
  assert.equal(result.ok, true);
  assert.deepEqual(result.productUrls, ['https://www.sesum.no/produkt/101-yoghurt']);
  assert.deepEqual(result.nextUrls, ['https://www.sesum.no/sok?q=yoghurt&side=2']);
  assert.equal(result.endReached, false);
  const unknown = core.parseSearch(html({ search: 'yoghurt' }, '<a href="/produkt/101-yoghurt">Vare</a>'), searchUrl);
  assert.equal(unknown.ok, true);
  assert.equal(unknown.endReached, false);
});

test('search completion needs explicit list end; an empty proven result is valid', () => {
  const result = core.parseSearch(html({ pagination: { total: 1, hasMore: false } }, '<a href="/produkt/101-yoghurt">Vare</a>'), searchUrl);
  assert.equal(result.endReached, true);
  const empty = core.parseSearch(html({ pagination: { total: 0, hasMore: false } }), searchUrl);
  assert.equal(empty.ok, true);
  assert.equal(empty.endReached, true);
  assert.equal(core.parseSearch(html({ pagination: { total: 2, hasMore: false } }), searchUrl).ok, false);
  assert.equal(core.parseSearch(html({ pagination: { total: 2, hasMore: false } }, '<a href="/produkt/101-yoghurt">Vare</a>'), searchUrl).ok, false);
});

test('observed SSR hit count proves full coverage only when all distinct product cards are present', () => {
  const filters = { query: 'yoghurt', categoryId: null, chains: [], brand: null, filter: null, page: 1 };
  const links = '<p>2<!-- --> treff</p><a href="/produkt/101-yoghurt">Yoghurt æøå</a><a href="/produkt/202-yoghurt">Yoghurt to</a>';
  const complete = core.parseSearch(html(filters, links), searchUrl);
  assert.equal(complete.ok, true);
  assert.equal(complete.endReached, true);
  assert.equal(complete.pagination.total, 2);
  const partial = core.parseSearch(html(filters, '<p>2<!-- --> treff</p><a href="/produkt/101-yoghurt">Vare</a>'), searchUrl);
  assert.equal(partial.ok, true);
  assert.equal(partial.endReached, false);
  assert.equal(core.parseSearch(html({ ...filters, query: 'annet' }, links), searchUrl).ok, false);
});

test('generic empty-query filter panel does not replace URL query; active filters cannot certify all products', () => {
  const filters = { query: '', categoryId: null, chains: [], brand: null,
    filter: { onlyPromo: false, onlyEco: false, promoType: null, sort: 'lowestPrice' }, page: 1 };
  const links = '<p>1<!-- --> treff</p><a href="/produkt/101-yoghurt">Vare</a>';
  assert.equal(core.parseSearch(html(filters, links), searchUrl).endReached, true);
  for (const active of [{ ...filters, categoryId: 8 }, { ...filters, brand: 'Eksempel' },
    { ...filters, filter: { ...filters.filter, onlyPromo: true } },
    { ...filters, filter: { ...filters.filter, onlyEco: true } },
    { ...filters, filter: { ...filters.filter, promoType: 'member' } }]) {
    const parsed = core.parseSearch(html(active, links), searchUrl);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.endReached, false);
    assert.deepEqual(parsed.errors, ['active_search_filter']);
    assert.equal(parsed.productUrls.length, 1, 'filtered candidates remain readable without certifying coverage');
  }
});

test('resource overflow is explicit failure without a partial product list', () => {
  const oversized = ' '.repeat(core.LIMITS.inputChars + 1);
  const result = core.parseSearch(oversized, searchUrl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.productUrls, []);
  assert.deepEqual(result.errors, ['input_limit']);
});

test('allowed read URL scope excludes other origins, credentials, fragments and unrelated paths', () => {
  assert.equal(core.allowedUrl(productUrl, 'product'), true);
  assert.equal(core.allowedUrl(searchUrl, 'search'), true);
  for (const value of ['https://www.sesum.no/profil', 'https://www.sesum.no/sok',
    Object.assign(new URL('https://www.sesum.no/produkt/101'),{username:'synthetic-user',password:'synthetic-password'}).href, 'https://www.sesum.no/produkt/101#secret',
    'http://www.sesum.no/produkt/101', 'https://www.sesum.no.evil.test/produkt/101']) {
    assert.equal(core.allowedUrl(value), false);
  }
});
