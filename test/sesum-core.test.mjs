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
  for (const invalid of [{ ...product, ean: ['bad'] }, { ...product, weight: '850' }]) {
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
  for (const ean of [['40x3'], [''], ['123456789012345'], ['4073', null], [4073]]) {
    const failed = core.parseProduct(html({ product: { ...source, ean }, prices: [price] }), productUrl);
    assert.equal(failed.ok, false);assert.deepEqual(failed.prices, [], 'malformed fields do not certify any own price');
  }
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
