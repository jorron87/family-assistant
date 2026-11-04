// Å opprette Intl.DateTimeFormat er dyrt (målt: 12 000 stk. = 0,7 s for én månedsvisning). Gjenbruk per språk + valg.
const cache = new Map();
export function dtf(locale, options) {
  const key = locale + JSON.stringify(options);
  let format = cache.get(key);
  if (!format) { format = new Intl.DateTimeFormat(locale, options); cache.set(key, format); }
  return format;
}
