// Demo mode: answers the same URLs as Kalshi, Sleeper and The Odds API with made-up data,
// so every screen can be tried without real markets. Turn it on in Settings.
import { NFL, STATS, GAME_SERIES, PROP_SERIES } from './config.js';
import { ABBR } from './util.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function makeDemoFetch() {
  const r = rng(11), pickFrom = (a) => a[Math.floor(r() * a.length)];
  const teams = Object.keys(NFL).sort(() => r() - 0.5);
  const games = Array.from({ length: 6 }, (_, i) => [teams[2 * i], teams[2 * i + 1]]);
  const mid = games.map(() => 0.3 + r() * 0.4);
  const truth = mid.map((m, i) => m + (i < 2 ? 0.06 : i === 2 ? -0.05 : (r() - 0.5) * 0.04));
  const gk = (i) => `26OCT18${ABBR[games[i][0]]}${ABBR[games[i][1]]}`;
  const first = ['Marcus', 'Dante', 'Tyler', 'Jalen', 'Cole', 'Andre', 'Trey', 'Nico', 'Devin', 'Isaiah'];
  const last = ['Holloway', 'Pruitt', 'Okafor', 'Mercer', 'Lindqvist', 'Batts', 'Caldwell', 'Rhodes', 'Vance', 'Tolbert'];
  const players = {};
  games.slice(0, 4).forEach(([ta, tb], gi) => [ta, tb].forEach((team) => {
    [['QB', 'pass_yd', 190, 290], ['WR', 'rec_yd', 40, 85], ['RB', 'rush_yd', 35, 85], ['WR', 'rec', 3, 7]].forEach(([pos, stat, lo, hi]) => {
      const pid = String(1000 + Object.keys(players).length);
      players[pid] = { full_name: `${pickFrom(first)} ${pickFrom(last)}`, team: ABBR[team], position: pos,
        injury_status: pickFrom([null, null, null, null, null, 'Questionable', 'Out']), mean: lo + r() * (hi - lo), stat, game: gi };
    });
  }));
  const tilt = {};
  const kick = (h) => new Date(Date.now() + (72 + h) * 36e5).toISOString();

  function route(url) {
    const [path, qs] = url.split('?');
    const q = Object.fromEntries((qs || '').split('&').filter(Boolean).map((kv) => kv.split('=').map(decodeURIComponent)));
    if (url.includes('sleeper.app')) {
      if (path.endsWith('/state/nfl')) return { season: '2026', week: 7, season_type: 'regular' };
      if (path.endsWith('/players/nfl')) {
        const o = {}; for (const [k, v] of Object.entries(players)) o[k] = { full_name: v.full_name, team: v.team, position: v.position, injury_status: v.injury_status };
        return o;
      }
      const m = path.match(/\/(stats|projections)\/nfl\/regular\/(\d+)\/(\d+)/);
      if (m) {
        const rr = rng(+m[2] * 100 + +m[3] + (m[1] === 'projections' ? 7 : 0)), o = {};
        const gauss = () => Math.sqrt(-2 * Math.log(rr() + 1e-9)) * Math.cos(2 * Math.PI * rr());
        for (const [pid, p] of Object.entries(players)) {
          const v = m[1] === 'stats' ? Math.max(0, p.mean + gauss() * 0.4 * p.mean) : p.mean;
          o[pid] = { [p.stat]: Math.round(v), gp: 1, off_snp: 50, tm_off_snp: 65 };
        }
        return o;
      }
    }
    if (url.includes('the-odds-api')) {
      return games.map(([ta, tb], i) => ({ bookmakers: [{ markets: [{ key: 'h2h', outcomes: [
        { name: ta, price: +(1 / (truth[i] * 1.02)).toFixed(3) }, { name: tb, price: +(1 / ((1 - truth[i]) * 1.02)).toFixed(3) }] }] }] }));
    }
    if (path.endsWith('/markets/trades')) {
      const tk = q.ticker || '', t = tilt[tk] ?? 0.5;
      return { cursor: '', trades: Array.from({ length: 30 + Math.floor(r() * 60) }, (_, j) => ({
        trade_id: `${tk}-${j}-${r()}`, count_fp: `${pickFrom([5, 20, 50, 100, 300, 1200, 2500, 5000])}.00`,
        yes_price_dollars: '0.50', no_price_dollars: '0.50', taker_side: r() < t ? 'yes' : 'no', created_time: new Date().toISOString() })) };
    }
    if (path.endsWith('/markets')) {
      const s = q.series_ticker, mk = [];
      if (s === GAME_SERIES) games.forEach(([ta, tb], i) => {
        const ev = `${GAME_SERIES}-${gk(i)}`;
        [[ta, mid[i]], [tb, 1 - mid[i]]].forEach(([team, pm]) => {
          const tk = `${ev}-${ABBR[team]}`;
          tilt[tk] = i < 2 ? (team === ta ? 0.9 : 0.1) : i === 2 ? (team === ta ? 0.15 : 0.85) : 0.5;
          mk.push({ ticker: tk, event_ticker: ev, yes_sub_title: team, title: `${ta} vs ${tb} Winner?`, occurrence_datetime: kick(i),
            yes_ask_dollars: (pm + 0.01).toFixed(2), yes_bid_dollars: (pm - 0.01).toFixed(2), no_ask_dollars: (1 - pm + 0.01).toFixed(2), volume_fp: String(1 + Math.floor(r() * 9)) });
        });
      });
      else if (PROP_SERIES[s]) {
        const stat = PROP_SERIES[s];
        for (const [pid, p] of Object.entries(players)) {
          if (p.stat !== stat) continue;
          const ev = `${s}-${gk(p.game)}`, step = stat === 'pass_yd' ? 25 : stat === 'rec' ? 1 : 10;
          const base = Math.floor(p.mean / step) * step;
          for (const line of [base - step, base, base + step, base + 2 * step]) {
            if (line <= 0) continue;
            let pf;
            if (STATS[stat].kind === 'poisson') { let term = Math.exp(-p.mean), cdf = 0; for (let k = 0; k < line; k++) { cdf += term; term *= p.mean / (k + 1); } pf = 1 - cdf; }
            else { const z = (line - 0.5 - p.mean) / (0.4 * p.mean); pf = 0.5 * (1 - Math.tanh(z * 0.8)); }
            pf = Math.min(0.93, Math.max(0.07, pf + (r() - 0.5) * 0.2));
            const tk = `${ev}-${pid}-${line}`; tilt[tk] = pickFrom([0.5, 0.85, 0.15, 0.5]);
            mk.push({ ticker: tk, event_ticker: ev, title: `${p.full_name}: ${line}+ ${STATS[stat].label}`, occurrence_datetime: kick(p.game),
              yes_ask_dollars: (pf + 0.01).toFixed(2), yes_bid_dollars: (pf - 0.01).toFixed(2), no_ask_dollars: (1 - pf + 0.01).toFixed(2), volume_fp: String(1 + Math.floor(r() * 9)) });
          }
        }
      }
      return { markets: mk, cursor: '' };
    }
    const one = path.match(/\/markets\/([^/]+)$/);
    if (one) return { market: { ticker: one[1], status: 'active', yes_ask_dollars: '0.55', yes_bid_dollars: '0.53', no_ask_dollars: '0.47' } };
    return {};
  }
  return async (url) => ({ ok: true, status: 200, json: async () => route(url) });
}
