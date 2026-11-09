/* Read-only parsers for SeSum's delivered HTML / React Server Component data.
 * Page code is untrusted: only JSON strings are decoded; nothing is evaluated.
 * A resource bound rejects the page instead of silently dropping products.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FamilienSesumCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ORIGIN = 'https://www.sesum.no';
  const LIMITS = Object.freeze({ inputChars: 16000000, nodes: 250000, depth: 180, textChars: 20000 });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const positiveId = (value) => /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const text = (value, nullable = true) => {
    if (value == null && nullable) return null;
    if (typeof value !== 'string' || value.length > LIMITS.textChars) throw new Error('invalid_text');
    return value;
  };

  function allowedUrl(value, kind) {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash) return false;
      if (kind === 'search') return url.pathname === '/sok' && !!url.searchParams.get('q')?.trim();
      if (kind === 'product') return /^\/produkt\/[1-9]\d*(?:-[^/?#]+)?\/?$/.test(url.pathname);
      return allowedUrl(value, 'search') || allowedUrl(value, 'product');
    } catch { return false; }
  }

  function sourceUrl(value, kind) {
    if (!allowedUrl(value, kind)) throw new Error('invalid_source_url');
    return new URL(value).toString();
  }

  function entities(value) {
    return String(value).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (match) => {
      const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
      if (own(named, match.toLowerCase())) return named[match.toLowerCase()];
      const hex = /^&#x/i.test(match);
      const code = Number.parseInt(match.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    });
  }

  function safeLink(value, base, kind) {
    try {
      const url = new URL(entities(value), base);
      url.hash = '';
      return allowedUrl(url.toString(), kind) ? url.toString() : null;
    } catch { return null; }
  }

  function attribute(attributes, name) {
    const match = String(attributes).match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
    return match ? entities(match[1] ?? match[2] ?? match[3]) : null;
  }

  function readData(input) {
    if (typeof input !== 'string' || input.length > LIMITS.inputChars) throw new Error('input_limit');
    const parts = [];
    const scripts = [...input.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
    for (const script of scripts) {
      const body = script[1];
      const pattern = /(?:self\.)?__next_f\.push\(\s*(\[\s*1\s*,\s*"(?:\\[\s\S]|[^"\\])*"\s*\])\s*\)/g;
      let count = 0;
      for (const match of body.matchAll(pattern)) {
        let pair;
        try { pair = JSON.parse(match[1]); } catch { throw new Error('invalid_next_stream'); }
        if (pair[0] === 1 && typeof pair[1] === 'string') { parts.push(pair[1]); count++; }
      }
      if (/__next_f\.push\(\s*\[\s*1\s*,/.test(body) && !count) throw new Error('invalid_next_stream');
    }
    const stream = scripts.length ? parts.join('') : input;
    const records = new Map();
    for (const line of stream.split('\n')) {
      const match = line.match(/^([\da-f]+):([\s\S]*)$/i);
      if (!match || !/^[\[{]/.test(match[2])) continue;
      let value;
      try { value = JSON.parse(match[2]); } catch { throw new Error('invalid_rsc_json'); }
      if (records.has(match[1]) && JSON.stringify(records.get(match[1])) !== JSON.stringify(value)) throw new Error('conflicting_rsc_record');
      records.set(match[1], value);
    }
    if (!records.size) throw new Error('missing_rsc_data');
    const resolve = (value) => {
      const seen = new Set();
      while (typeof value === 'string' && /^\$[\da-f]+$/i.test(value)) {
        const id = value.slice(1);
        if (seen.has(id) || !records.has(id)) throw new Error('unresolved_rsc_reference');
        seen.add(id); value = records.get(id);
      }
      return value;
    };
    let nodes = 0;
    const walk = (callback) => {
      const visit = (value, depth) => {
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new Error('structure_limit');
        if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
        else if (object(value)) {
          callback(value, resolve);
          for (const item of Object.values(value)) visit(item, depth + 1);
        }
      };
      for (const value of records.values()) visit(value, 0);
    };
    return { records, resolve, walk };
  }

  function normalizeProduct(raw, url) {
    if (!object(raw) || !positiveId(raw.id) || typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('invalid_product');
    let ean = raw.ean == null ? null : raw.ean;
    if (typeof ean === 'number' && Number.isSafeInteger(ean)) ean = String(ean);
    if (typeof ean === 'string') ean = [ean];
    // This delivered field sometimes mixes barcodes with short catalogue
    // codes. Keep short digit strings as separate evidence; they are neither
    // EANs nor reviewed identities and must never enter barcode matching.
    if (ean !== null && (!Array.isArray(ean) || ean.length > 30 || ean.some((item) => typeof item !== 'string' || !/^\d{1,14}$/.test(item)))) throw new Error('invalid_ean');
    const barcodes = [...new Set((ean ?? []).filter(item => item.length >= 8))];
    const nonEanCodes = [...new Set((ean ?? []).filter(item => item.length < 8))];
    if (raw.weight != null && (!finite(raw.weight) || raw.weight <= 0)) throw new Error('invalid_weight');
    if (raw.soldByWeight != null && typeof raw.soldByWeight !== 'boolean') throw new Error('invalid_sold_by_weight');
    return {
      id: positiveId(raw.id), name: text(raw.name, false), brand: text(raw.brand), vendor: text(raw.vendor),
      ean: barcodes.length ? barcodes : null, nonEanCodes, weight: raw.weight ?? null, weightUnit: text(raw.weightUnit),
      soldByWeight: raw.soldByWeight ?? null, sourceUrl: url
    };
  }

  function promotion(raw) {
    if (raw == null) return null;
    if (!object(raw)) throw new Error('invalid_promotion');
    const result = {};
    const keys = ['id', 'title', 'description', 'startsAt', 'endsAt', 'startDate', 'endDate',
      'valid_from', 'valid_to', 'valid_until', 'validFrom', 'validTo', 'validUntil',
      'multi_buy_quantity', 'multi_buy_price', 'multi_buy_pay_for', 'memberOnly', 'member_only',
      'memberProgram', 'member_program', 'customerLimit', 'customer_limit', 'limit', 'quantity', 'price',
      'conditions', 'maxQuantity', 'max_quantity', 'source', 'url'];
    for (const key of keys) if (own(raw, key)) {
      const value = raw[key];
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('invalid_promotion_field');
      if (typeof value === 'string') text(value);
      if (typeof value === 'number' && !finite(value)) throw new Error('invalid_promotion_field');
      result[key] = value;
    }
    return result;
  }

  function normalizePrice(raw) {
    if (!object(raw) || !positiveId(raw.storeId) || !/^[A-Z][A-Z\d_]{0,63}$/.test(raw.storeCode ?? '') ||
      !finite(raw.price) || raw.price <= 0 || typeof raw.source !== 'string' || !raw.source ||
      typeof raw.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt)) ||
      typeof raw.isPromo !== 'boolean') throw new Error('invalid_price_receipt');
    return {
      storeCode: raw.storeCode, storeId: positiveId(raw.storeId), price: raw.price,
      rawUnitPrice: finite(raw.unitPrice) ? raw.unitPrice : null,
      source: text(raw.source, false), observedAt: raw.observedAt, isPromo: raw.isPromo, promotion: promotion(raw.promotion)
    };
  }

  function failure(kind, url, error) {
    return { ok: false, kind, sourceUrl: typeof url === 'string' ? url : null,
      ...(kind === 'product' ? { product: null, prices: [], candidates: [] } :
        { products: [], productUrls: [], nextUrls: [], endReached: false, pagination: { complete: false, endReached: false, nextUrls: [], total: null } }),
      errors: [error instanceof Error ? error.message : 'parse_failed'] };
  }

  function parseProduct(input, url) {
    try {
      url = sourceUrl(url, 'product');
      const requestedId = positiveId(new URL(url).pathname.match(/^\/produkt\/(\d+)/)[1]);
      const data = readData(input), found = [];
      data.walk((node, resolve) => {
        if (!own(node, 'product') || !own(node, 'prices')) return;
        const raw = resolve(node.product), prices = resolve(node.prices);
        if (object(raw) && positiveId(raw.id) === requestedId && Array.isArray(prices)) found.push({ node, raw, prices });
      });
      if (!found.length) throw new Error('missing_own_product_prices');
      const normalized = found.map(({ raw, prices }) => ({ product: normalizeProduct(raw, url), prices: prices.map(normalizePrice) }));
      const unique = new Map(normalized.map((item) => [JSON.stringify(item), item]));
      if (unique.size !== 1) throw new Error('conflicting_own_product_prices');
      const { product, prices } = unique.values().next().value;
      const chainRows = new Map();
      for (const row of prices) {
        const key = row.storeCode + ':' + row.storeId;
        if (chainRows.has(key) && chainRows.get(key) !== JSON.stringify(row)) throw new Error('conflicting_chain_prices');
        chainRows.set(key, JSON.stringify(row));
      }
      const candidates = new Map();
      for (const { node } of found) {
        const related = data.resolve(node.tilsvarende);
        if (!Array.isArray(related)) continue;
        for (const item of related) {
          const raw = object(item?.product) ? item.product : item;
          const id = positiveId(raw?.id);
          if (!id || id === requestedId) continue;
          const candidateUrl = typeof raw.sourceUrl === 'string' ? safeLink(raw.sourceUrl, url, 'product') : null;
          candidates.set(id, { id, name: typeof raw.name === 'string' ? text(raw.name) : null,
            sourceUrl: candidateUrl, reason: 'site_similarity_not_reviewed' });
        }
      }
      return { ok: true, kind: 'product', sourceUrl: url, product, prices, candidates: [...candidates.values()], errors: [] };
    } catch (error) { return failure('product', url, error); }
  }

  function parseSearch(input, url) {
    try {
      url = sourceUrl(url, 'search');
      const data = readData(input);
      const products = new Map(), nextUrls = new Set();
      const query = new URL(url).searchParams.get('q');
      for (const match of input.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
        const href = attribute(match[1], 'href');
        if (!href) continue;
        const productUrl = safeLink(href, url, 'product');
        if (productUrl) {
          const id = positiveId(new URL(productUrl).pathname.match(/^\/produkt\/(\d+)/)[1]);
          const name = entities(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
          if (!products.has(id)) products.set(id, { id, name: name || null, sourceUrl: productUrl });
        }
        const nextUrl = safeLink(href, url, 'search');
        const label = attribute(match[1], 'aria-label') ?? entities(match[2].replace(/<[^>]*>/g, ' ')).trim();
        if (nextUrl && new URL(nextUrl).searchParams.get('q') === query && nextUrl !== url &&
          (/\bnext\b/i.test(attribute(match[1], 'rel') ?? '') || /^(?:neste(?:\s+side)?|next(?:\s+page)?)\s*[›»→]?$/i.test(label))) nextUrls.add(nextUrl);
      }
      let total = null, explicitEnd = false, activeFilter = false;
      const filters = [];
      data.walk((node) => {
        if (typeof node.query === 'string' && Number.isSafeInteger(node.page) && own(node, 'chains') && own(node, 'filter')) {
          // The delivered filter panel can use query:"" even while the URL
          // contains the actual search. Never replace the requested query with
          // this generic panel default.
          if (node.query && node.query !== query) throw new Error('search_query_mismatch');
          const filter = object(node.filter) ? node.filter : {};
          if (node.categoryId != null || node.brand != null || filter.onlyPromo === true ||
            filter.onlyEco === true || filter.promoType != null) activeFilter = true;
          filters.push({ categoryId: node.categoryId ?? null, brand: node.brand ?? null,
            onlyPromo: filter.onlyPromo === true, onlyEco: filter.onlyEco === true,
            promoType: filter.promoType ?? null, sort: filter.sort ?? null });
        }
        // Only a named pagination object is evidence of an exhausted list. A
        // missing next link alone can also mean hydration or schema changed.
        if (!object(node.pagination)) return;
        const page = node.pagination;
        if (Number.isSafeInteger(page.total) && page.total >= 0) {
          if (total !== null && total !== page.total) throw new Error('conflicting_search_total');
          total = page.total;
        }
        if (page.hasMore === false || page.endReached === true || page.complete === true) explicitEnd = true;
        if (typeof page.nextUrl === 'string') {
          const link = safeLink(page.nextUrl, url, 'search');
          if (!link || new URL(link).searchParams.get('q') !== query || link === url) throw new Error('invalid_next_url');
          nextUrls.add(link);
        }
      });
      // The observed search renders one server-side product card per hit and a
      // visible "N treff" count (sometimes split by HTML comment delimiters).
      // Equal counts prove this response contains the whole result; merely
      // lacking a next link never does. No offsets or next URLs are invented.
      const visible = entities(input.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
      const counts = [...visible.matchAll(/\b(\d[\d\s]{0,20})\s+treff\b/gi)]
        .map((match) => Number(match[1].replace(/\s/g, '')));
      if (!counts.length && /\bingen treff\b/i.test(visible)) counts.push(0);
      for (const count of counts) {
        if (!Number.isSafeInteger(count) || count < 0 || (total !== null && total !== count)) throw new Error('conflicting_search_total');
        total = count;
      }
      if (total !== null && products.size > total) throw new Error('search_count_mismatch');
      if (total !== null && total === products.size) explicitEnd = true;
      if (explicitEnd && total !== null && !new URL(url).searchParams.has('page') && !new URL(url).searchParams.has('side') && products.size !== total) {
        throw new Error('search_count_mismatch');
      }
      const endReached = nextUrls.size === 0 && explicitEnd && !activeFilter;
      if (!products.size && total !== 0) throw new Error('missing_search_products');
      return { ok: true, kind: 'search', sourceUrl: url, products: [...products.values()],
        productUrls: [...products.values()].map((item) => item.sourceUrl), nextUrls: [...nextUrls], endReached,
        pagination: { complete: endReached, endReached, nextUrls: [...nextUrls], total },
        filters, errors: activeFilter ? ['active_search_filter'] : [] };
    } catch (error) { return failure('search', url, error); }
  }

  return Object.freeze({ ORIGIN, LIMITS, allowedUrl, parseProduct, parseSearch });
});
