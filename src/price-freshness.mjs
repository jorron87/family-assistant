// How long an actual price receipt counts as a current price for comparisons,
// cheapest-price displays and good-buy suggestions.
//
// Several sources date a price by the latest actual observation of it: Sesum
// rows are dated by the newest shopper receipt, Kassal by its last check and
// Oda by our own read. A stable shelf price can therefore be seen only every
// week or two while still being the price in the shop. The household chose
// three weeks (22 November 2026). Campaign prices keep their own end dates and
// unverified campaign terms stay held; this window never revives an ended offer.
// Statistical market calibration keeps its separate, stricter recency rule.
export const CURRENT_PRICE_DAYS=21;
export const CURRENT_PRICE_MS=CURRENT_PRICE_DAYS*86400000;
// A price older than this is still current, but the page says when it was seen.
export const RECENT_PRICE_MS=48*3600000;

export function priceAgeMs(time,at=Date.now()) {
 const t=typeof time==='number'?time:Date.parse(time);
 return Number.isFinite(t)?at-t:null;
}
/** An actual receipt from the past three weeks (a minute of clock skew allowed). */
export function currentPriceReceipt(time,at=Date.now(),{skewMs=0}={}) {
 const age=priceAgeMs(time,at);
 return age!==null&&age>=-skewMs&&age<=CURRENT_PRICE_MS;
}
