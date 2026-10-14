import { KALSHI } from './config.js';
import { getJson } from './api.js';
import { price, contracts, marketVolume } from './util.js';

/** Recent trades per market. Only re-fetches a market when its volume changed. */
export class TradeTape {
  constructor() { this.t = {}; }
  async update(m, lookbackHours) {
    const tk = m.ticker, vol = marketVolume(m);
    const rec = (this.t[tk] ||= { vol: null, since: null, trades: {} });
    const horizon = Date.now() / 1000 - lookbackHours * 3600;
    if (rec.vol !== vol) {
      const minTs = Math.floor(Math.max(horizon, (rec.since ?? horizon) - 120));
      const fetchedAt = Date.now() / 1000;
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const d = await getJson(`${KALSHI}/markets/trades`, { ticker: tk, min_ts: minTs, limit: 1000, cursor });
        for (const tr of d.trades || []) {
          const yp = price(tr, 'yes_price'); let np = price(tr, 'no_price');
          const side = (tr.taker_side || tr.taker_outcome_side || '').toLowerCase();
          if (yp === null || (side !== 'yes' && side !== 'no')) continue;
          if (np === null) np = 1 - yp;
          const ts = Date.parse(tr.created_time) / 1000 || fetchedAt;
          rec.trades[tr.trade_id || `${tk}${ts}${side}`] = [ts, side, contracts(tr) * (side === 'yes' ? yp : np)];
        }
        cursor = d.cursor;
        if (!cursor) break;
      }
      rec.vol = vol; rec.since = fetchedAt;
    }
    for (const [k, v] of Object.entries(rec.trades)) if (v[0] < horizon) delete rec.trades[k];
    return Object.values(rec.trades);
  }
  static tally(trades, big) {
    const o = { yes_big: 0, no_big: 0, yes_all: 0, no_all: 0, big_count: 0 };
    for (const [, side, usd] of trades) {
      o[side + '_all'] += usd;
      if (usd >= big) { o[side + '_big'] += usd; o.big_count++; }
    }
    return o;
  }
}

/** 0-100: how one-sided big money is, scaled by how much of it there is. */
export function moneySignal(backA, backB, big) {
  const total = backA + backB;
  if (total <= 0) return { side: null, score: 0, total: 0 };
  const lean = (backA - backB) / total;
  const conf = 1 - Math.exp(-total / (5 * big));
  return { side: lean > 0 ? 'a' : 'b', score: Math.round(100 * Math.abs(lean) * conf), total: Math.round(total) };
}
