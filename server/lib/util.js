import { NFL } from './config.js';

export const nowIso = () => new Date().toISOString();
export const isPast = (iso) => { const t = Date.parse(iso || ''); return !isNaN(t) && t <= Date.now(); };
export const hoursSince = (iso) => (Date.now() - Date.parse(iso)) / 3.6e6;

export function num(d, ...keys) {
  for (const k of keys) {
    const v = d?.[k];
    if (v !== undefined && v !== null && v !== '') { const n = parseFloat(v); if (!isNaN(n)) return n; }
  }
  return null;
}
// Kalshi now sends prices as dollar strings (yes_ask_dollars); older fields are cents.
export function price(d, base) {
  const v = num(d, base + '_dollars');
  if (v !== null) return v;
  const c = num(d, base);
  return c === null ? null : c / 100;
}
export const contracts = (d) => num(d, 'count_fp', 'count') || 0;
export const marketVolume = (m) => num(m, 'volume_fp', 'volume') || 0;

/** Cheapest price to buy YES and to buy NO on one market, plus the bid/ask spread. */
export function costs(m) {
  const ya = price(m, 'yes_ask'), yb = price(m, 'yes_bid');
  let na = price(m, 'no_ask');
  if (na === null && yb !== null) na = 1 - yb;
  const ok = (x) => (x !== null && x > 0 && x < 1 ? x : null);
  return { yes: ok(ya), no: ok(na), spread: ya !== null && yb !== null ? ya - yb : null };
}

export const fee = (p, s, maker = false) => (maker ? s.makerFeeRate : s.feeRate) * p * (1 - p);
export const orderFee = (c, p, s) => Math.ceil(100 * s.feeRate * c * p * (1 - p) - 1e-9) / 100;
/** Edge in percentage points if you take the price now (taker fee). */
export const edgePts = (fair, cost, s) => (fair == null || cost == null ? null : +(100 * (fair - cost - fee(cost, s))).toFixed(2));

/** Highest limit price that still clears your edge bar after the maker fee. */
export function maxPrice(fair, minEdge, s) {
  if (fair == null) return null;
  for (let c = 99; c > 0; c--) { const p = c / 100; if (100 * (fair - p - fee(p, s, true)) >= minEdge) return p; }
  return null;
}

/** Fractional Kelly for a $1-payout contract, capped at maxBetPct of bankroll. */
export function kelly(fair, cost, s) {
  if (fair == null || cost == null) return null;
  const c = cost + fee(cost, s);
  if (fair <= c || c >= 1) return null;
  const f = ((fair - c) / (1 - c)) * s.kellyFraction;
  const stake = Math.min(f * s.bankroll, (s.maxBetPct / 100) * s.bankroll);
  const n = Math.floor(stake / c);
  return n > 0 ? { contracts: n, stake: +(n * c).toFixed(2), pct: +((100 * n * c) / s.bankroll).toFixed(2) } : null;
}

// ---- probability
function erf(x) { // Abramowitz-Stegun 7.1.26, max error 1.5e-7
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
export const normalAtLeast = (line, mean, sd) => 0.5 * (1 - erf((line - 0.5 - mean) / (Math.max(sd, 1e-6) * Math.SQRT2)));
export function poissonAtLeast(line, mean) {
  if (mean <= 0) return 0;
  const k = Math.ceil(line - 1e-9); let term = Math.exp(-mean), cdf = 0;
  for (let i = 0; i < k; i++) { cdf += term; term *= mean / (i + 1); }
  return Math.max(0, 1 - cdf);
}

// ---- teams and names
const key = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const ABBR = {};
const ALIAS = {};
for (const [full, al] of Object.entries(NFL)) {
  const parts = al.split('|'); ABBR[full] = parts[0];
  for (const a of [full, ...parts]) ALIAS[key(a)] = full;
  ALIAS[key(parts[0] + parts[parts.length - 1])] = full;
}
export function teamOf(name) {
  const k = key(name);
  if (ALIAS[k]) return ALIAS[k];
  for (const [full, al] of Object.entries(NFL)) {
    for (const a of [full, ...al.split('|').slice(1)]) if (a.length > 3 && k.includes(key(a))) return full;
  }
  return null;
}
/** KXNFLGAME-26OCT18KCLV and KXNFLRECYDS-26OCT18KCLV share the part after the first dash. */
export const gameKey = (eventTicker) => { const s = eventTicker || ''; const i = s.indexOf('-'); return i < 0 ? s : s.slice(i + 1); };
export function normName(s) {
  return (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ')
    .split(/\s+/).filter((w) => w && !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(w)).join(' ');
}
export const shortTeam = (t) => (t || '').split(' ').slice(-1)[0];
export const cents = (p) => (p == null ? '—' : `${Math.round(p * 100)}¢`);
export const pct = (p, d = 0) => (p == null ? '—' : `${(p * 100).toFixed(d)}%`);
export const usd = (n) => (n == null ? '—' : n >= 1000 ? `$${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : `$${Math.round(n)}`);
