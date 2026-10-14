import { KALSHI, ODDS, GAME_SERIES, PROP_SERIES, STATS, TITLE_STATS, OUT_STATUSES, DEFAULT_SETTINGS } from './config.js';
import { getJson } from './api.js';
import { TradeTape, moneySignal } from './tape.js';
import { SleeperData } from './sleeper.js';
import { costs, edgePts, maxPrice, kelly, fee, orderFee, teamOf, gameKey, ABBR, nowIso, isPast, hoursSince } from './util.js';

const TITLE_RE = /^\s*(.+?):\s*([\d,]+(?:\.\d+)?)\+\s*(.*)$/;

export class Engine {
  constructor(storage) {
    this.storage = storage;
    this.tape = new TradeTape();
    this.sleeper = new SleeperData(storage);
    this.settings = { ...DEFAULT_SETTINGS };
    this.sharpmush = {}; this.myFair = {}; this.bets = []; this.pickLog = [];
    this.games = []; this.props = []; this.picks = []; this.errors = [];
    this.updated = null; this.propsUpdated = null; this.odds = { t: 0, fair: {}, error: null };
    this.busy = false; this.progress = ''; this.newPicks = []; this.remoteRecord = null; this.lastScan = null;
  }
  async load() {
    const g = async (k, d) => (await this.storage.get(k)) ?? d;
    this.settings = { ...DEFAULT_SETTINGS, ...(await g('settings', {})) };
    this.sharpmush = await g('sharpmush', {}); this.myFair = await g('myFair', {});
    this.bets = await g('bets', []); this.pickLog = await g('pickLog', []);
  }
  save(key) { return this.storage.set(key, this[key]); }

  // ------------------------------------------------------------ Kalshi
  async openMarkets(series) {
    let out = [], cursor = null;
    for (let i = 0; i < 20; i++) {
      const d = await getJson(`${KALSHI}/markets`, { series_ticker: series, status: 'open', limit: 1000, cursor });
      out = out.concat(d.markets || []); cursor = d.cursor;
      if (!cursor) break;
    }
    return out;
  }
  static kickoff(m) { return m.occurrence_datetime || m.expected_expiration_time || m.close_time || null; }

  async sharpBookFair() {
    const key = this.settings.oddsApiKey;
    if (!key || Date.now() - this.odds.t < this.settings.oddsMinutes * 6e4) return this.odds.fair;
    try {
      const d = await getJson(`${ODDS}/sports/americanfootball_nfl/odds`,
        { apiKey: key, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', bookmakers: 'pinnacle' });
      const fair = {};
      for (const ev of d || []) for (const bk of ev.bookmakers || []) for (const mk of bk.markets || []) {
        if (mk.key !== 'h2h') continue;
        const oc = (mk.outcomes || []).map((o) => [teamOf(o.name), 1 / +o.price]).filter(([t]) => t);
        if (oc.length === 2) {
          const s = oc[0][1] + oc[1][1];
          fair[`${oc[0][0]}|${oc[1][0]}`] = oc[0][1] / s; fair[`${oc[1][0]}|${oc[0][0]}`] = oc[1][1] / s;
        }
      }
      this.odds = { t: Date.now(), fair, error: null };
    } catch (e) { this.odds = { ...this.odds, t: Date.now(), error: `Odds API: ${e.message}` }; }
    return this.odds.fair;
  }

  // ------------------------------------------------------------ games
  async buildGames() {
    const S = this.settings, big = S.gameBigTrade;
    const byEvent = {};
    for (const m of await this.openMarkets(GAME_SERIES)) (byEvent[m.event_ticker] ||= []).push(m);
    const sharp = await this.sharpBookFair();
    const games = {};
    for (const [ev, mks] of Object.entries(byEvent)) {
      if (mks.length !== 2) continue;
      const [a, b] = mks;
      const ta = teamOf(a.yes_sub_title || a.title) || a.yes_sub_title || 'Team A';
      const tb = teamOf(b.yes_sub_title || b.title) || b.yes_sub_title || 'Team B';
      const gk = gameKey(ev);
      const tra = TradeTape.tally(await this.tape.update(a, S.lookbackHours), big);
      const trb = TradeTape.tally(await this.tape.update(b, S.lookbackHours), big);
      const backA = tra.yes_big + trb.no_big, backB = trb.yes_big + tra.no_big;   // NO on B = backing A
      const money = moneySignal(backA, backB, big);
      const ca = costs(a), cb = costs(b);
      const pick = (y, n) => (y != null && (n == null || y <= n) ? y : n);
      const costA = pick(ca.yes, cb.no), costB = pick(cb.yes, ca.no);
      const howA = costA === ca.yes ? ['yes', a.ticker, ca.spread] : ['no', b.ticker, cb.spread];
      const howB = costB === cb.yes ? ['yes', b.ticker, cb.spread] : ['no', a.ticker, ca.spread];
      let fairA = null, fairSrc = null;
      if (this.myFair[gk] != null) { fairA = +this.myFair[gk]; fairSrc = 'your number'; }
      else if (sharp[`${ta}|${tb}`] != null) { fairA = sharp[`${ta}|${tb}`]; fairSrc = 'Pinnacle, no vig'; }
      const edgeA = edgePts(fairA, costA, S), edgeB = edgePts(fairA == null ? null : 1 - fairA, costB, S);
      const bestEdge = [edgeA, edgeB].filter((e) => e != null).reduce((m, e) => Math.max(m, e), -Infinity);
      const best = bestEdge === -Infinity ? null : bestEdge;
      const valueSide = best == null || best <= 0 ? null : best === edgeA ? 'a' : 'b';
      const sm = this.sharpmush[gk];
      const smAge = sm ? hoursSince(sm.time) : null;
      const smOk = !!sm && sm.pct >= S.minSharpMush && smAge < S.sharpMushStaleHours;
      const vOk = best != null && best >= S.gameMinEdge, mOk = money.score >= S.gameMinMoney;
      let status;
      if (sm) status = smOk && vOk && sm.side === valueSide ? 'gold' : smOk && vOk ? 'split' : 'quiet';
      else status = vOk && mOk && money.side === valueSide ? 'gold' : vOk && mOk ? 'split' : 'quiet';
      const winProbA = costA != null && costB != null ? (costA + (1 - costB)) / 2 : null;
      const side = (k) => ({ team: k === 'a' ? ta : tb, abbr: ABBR[k === 'a' ? ta : tb] || '', cost: k === 'a' ? costA : costB,
        back: k === 'a' ? backA : backB, edge: k === 'a' ? edgeA : edgeB,
        how: k === 'a' ? howA : howB, fair: fairA == null ? null : k === 'a' ? fairA : 1 - fairA });
      const g = {
        key: gk, kickoff: Engine.kickoff(a), a: side('a'), b: side('b'), fairA, fairSrc, money, bigTrades: tra.big_count + trb.big_count,
        valueSide, bestEdge: best, status, winProbA, eventTicker: ev,
        sharpmush: sm ? { ...sm, ageH: smAge, ok: smOk } : null,
        basis: sm ? 'SharpMush + value' : 'Value + Kalshi money (no SharpMush entered)',
      };
      if (valueSide) {
        const s = g[valueSide];
        g.candidate = {
          kind: 'game', id: `${s.how[1]}:${s.how[0]}`, title: `${s.team} to win`, sub: `${ta} vs ${tb}`,
          ticker: s.how[1], side: s.how[0], cost: s.cost, fair: s.fair, edge: s.edge, spread: s.how[2],
          kickoff: g.kickoff, game: gk, eventTicker: ev, status,
          maxPrice: maxPrice(s.fair, S.gameMinEdge, S), size: kelly(s.fair, s.cost, S),
          smAgrees: smOk && sm.side === valueSide, moneyAgrees: mOk && money.side === valueSide,
          moneyAgainst: mOk && money.side && money.side !== valueSide, injured: false, confident: true,
        };
      }
      games[gk] = g;
    }
    return games;
  }

  // ------------------------------------------------------------ props
  parseProp(m, series) {
    const title = m.title || '', sub = m.yes_sub_title || '';
    if (/career|season/i.test(title + (m.event_ticker || ''))) return null;
    const mt = title.match(TITLE_RE) || sub.match(TITLE_RE);
    if (!mt) return null;
    const name = mt[1].trim(), line = parseFloat(mt[2].replace(/,/g, '')), rest = (mt[3] || '').toLowerCase();
    const stat = (TITLE_STATS.find(([kw]) => rest.includes(kw)) || [])[1] || PROP_SERIES[series];
    if (!STATS[stat] || !(line > 0) || line > STATS[stat].max || /defense|d\/st/i.test(name)) return null;
    return { name, line, stat };
  }

  async buildProps(games) {
    const S = this.settings, big = S.propBigTrade, rows = [];
    for (const series of Object.keys(PROP_SERIES)) {
      let mks;
      try { mks = await this.openMarkets(series); } catch (e) { continue; }
      for (const m of mks) {
        const p = this.parseProp(m, series);
        if (!p) continue;
        const gk = gameKey(m.event_ticker), g = games[gk];
        const teams = g ? [g.a.abbr, g.b.abbr] : null;
        const pid = this.sleeper.match(p.name, teams);
        const pl = pid ? this.sleeper.players[pid] : {};
        let wp = null;
        if (g && g.winProbA != null && pl.team) wp = pl.team === g.a.abbr ? g.winProbA : pl.team === g.b.abbr ? 1 - g.winProbA : null;
        const model = pid ? this.sleeper.fair(pid, p.stat, p.line, wp) : null;
        const c = costs(m), fair = model?.fair ?? null;
        const eYes = edgePts(fair, c.yes, S), eNo = edgePts(fair == null ? null : 1 - fair, c.no, S);
        const best = [eYes, eNo].filter((e) => e != null).reduce((a, e) => Math.max(a, e), -Infinity);
        const bestEdge = best === -Infinity ? null : best;
        const vSide = bestEdge == null || bestEdge <= 0 ? null : bestEdge === eYes ? 'yes' : 'no';
        // Only read the trade tape where there's value: keeps the phone's data use and API calls low.
        let t = { yes_big: 0, no_big: 0, yes_all: 0, no_all: 0, big_count: 0 };
        if (vSide) t = TradeTape.tally(await this.tape.update(m, S.lookbackHours), big);
        const money = moneySignal(t.yes_big, t.no_big, big);
        money.side = { a: 'yes', b: 'no' }[money.side] || null;
        const inj = pl.inj || null;
        const out = OUT_STATUSES.includes((inj || '').toLowerCase()) || /injured reserve|inactive/i.test(pl.status || '');
        const vOk = bestEdge != null && bestEdge >= S.propMinEdge, mOk = money.score >= S.propMinMoney;
        const status = out ? 'out' : vOk && mOk && money.side === vSide ? 'gold' : vOk && mOk ? 'split' : vOk ? 'value' : 'quiet';
        const lineTxt = Number.isInteger(p.line) ? p.line : p.line.toFixed(1);
        const row = {
          ticker: m.ticker, game: gk, gameTitle: g ? `${g.a.team} vs ${g.b.team}` : gk, kickoff: Engine.kickoff(m),
          eventTicker: m.event_ticker, player: p.name, matched: !!pid, team: pl.team, pos: pl.pos, injury: inj,
          stat: p.stat, statLabel: STATS[p.stat].label, line: p.line, yes: c.yes, no: c.no, spread: c.spread,
          fair, eYes, eNo, valueSide: vSide, bestEdge, money, volume: Math.round(t.yes_all + t.no_all),
          thin: t.yes_all + t.no_all < 5 * big, model, status, label: `${p.name} ${lineTxt}+ ${STATS[p.stat].label}`,
        };
        if (vSide && !out) {
          const sf = vSide === 'yes' ? fair : 1 - fair, cost = vSide === 'yes' ? c.yes : c.no;
          row.candidate = {
            kind: 'prop', id: `${m.ticker}:${vSide}`, title: `${row.label}: ${vSide === 'yes' ? 'Yes' : 'No'}`,
            sub: `${row.gameTitle}${pl.team ? ` · ${pl.team} ${pl.pos || ''}` : ''}`,
            ticker: m.ticker, side: vSide, cost, fair: sf, edge: bestEdge, spread: c.spread, kickoff: row.kickoff,
            game: gk, eventTicker: g ? g.eventTicker : m.event_ticker, status,
            maxPrice: maxPrice(sf, S.propMinEdge, S), size: kelly(sf, cost, S),
            smAgrees: false, moneyAgrees: mOk && money.side === vSide, moneyAgainst: mOk && money.side && money.side !== vSide,
            injured: !!inj, confident: (model?.games || 0) >= S.safeMinGames || !!model?.hasProjection, model,
          };
        }
        rows.push(row);
      }
    }
    const order = { gold: 0, value: 1, split: 2, quiet: 3, out: 4 };
    rows.sort((x, y) => order[x.status] - order[y.status] || (y.bestEdge ?? -99) - (x.bestEdge ?? -99));
    return rows;
  }

  // ------------------------------------------------------------ Likely wins / Upside / Gold
  categorize(c) {
    const S = this.settings, cats = [];
    const spreadOk = c.spread == null || c.spread * 100 <= S.maxSpreadCents;
    const minEdge = c.kind === 'game' ? S.gameMinEdge : S.propMinEdge;
    if (c.edge > S.suspectEdge) return ['check'];        // too good to be true: verify before betting
    if (c.status === 'gold') cats.push('gold');
    if (c.fair * 100 >= S.safeMinProb && c.edge >= S.safeMinEdge && spreadOk && !c.injured && !c.moneyAgainst && c.confident)
      cats.push('safe');
    if (c.cost * 100 <= S.upsideMaxPrice && c.fair * 100 >= S.upsideMinProb && c.edge >= Math.max(S.upsideMinEdge, minEdge)
      && spreadOk && !c.injured && (c.smAgrees || c.moneyAgrees) && c.confident) cats.push('upside');
    return cats;
  }

  buildPicks() {
    const cands = [...this.games.map((g) => g.candidate), ...this.props.map((r) => r.candidate)].filter(Boolean);
    const picks = [];
    for (const c of cands) {
      if (isPast(c.kickoff)) continue;
      const cats = this.categorize(c);
      if (cats.length) picks.push({ ...c, cats, payout: 1 / c.cost, evPct: (100 * c.edge) / 100 / c.cost });
    }
    return picks;
  }

  // ------------------------------------------------------------ paper record of every pick
  async logPicks() {
    const byId = Object.fromEntries(this.pickLog.map((e) => [e.id, e]));
    const live = {}; const fresh = [];
    for (const p of this.picks) {
      live[p.id] = p.cost;
      const e = byId[p.id];
      if (!e) {
        const n = { id: p.id, time: nowIso(), kind: p.kind, title: p.title, sub: p.sub, ticker: p.ticker, side: p.side,
          cats: p.cats, priceAtAlert: p.cost, fair: p.fair, edge: p.edge, kickoff: p.kickoff, closePrice: p.cost, result: null };
        this.pickLog.unshift(n); byId[p.id] = n; fresh.push(p);
      } else {
        const added = p.cats.filter((c) => !(e.cats || []).includes(c));
        if (added.length) { e.cats = [...new Set([...(e.cats || []), ...p.cats])]; fresh.push({ ...p, cats: added }); }
      }
    }
    // Keep updating the price of logged picks until kickoff: that last price is the close.
    for (const r of this.props) for (const s of ['yes', 'no']) live[`${r.ticker}:${s}`] ??= s === 'yes' ? r.yes : r.no;
    for (const g of this.games) for (const k of ['a', 'b']) live[`${g[k].how[1]}:${g[k].how[0]}`] ??= g[k].cost;
    for (const e of this.pickLog) if (e.result == null && !isPast(e.kickoff) && live[e.id] != null) e.closePrice = live[e.id];
    let checked = 0;
    for (const e of this.pickLog) {
      if (e.result != null || !e.kickoff || Date.parse(e.kickoff) + 4 * 36e5 > Date.now() || checked >= 15) continue;
      checked++;
      try {
        const m = (await getJson(`${KALSHI}/markets/${e.ticker}`)).market || {};
        const res = (m.result || '').toLowerCase();
        if (res === 'yes' || res === 'no') e.result = res === e.side ? 'win' : 'loss';
      } catch (err) { /* try again next refresh */ }
    }
    this.pickLog = this.pickLog.slice(0, 3000);
    this.newPicks = fresh.filter((p) => this.wantsAlert(p));
    await this.save('pickLog');
  }

  wantsAlert(p) {
    const S = this.settings;
    return p.cats.some((c) => (c === 'safe' && S.notifySafe) || (c === 'upside' && S.notifyUpside) || (c === 'gold' && S.notifyGold));
  }
  static alertText(p) {
    const name = { safe: 'Likely win', upside: 'Upside', gold: 'Signals agree' };
    const label = p.cats.filter((c) => name[c]).map((c) => name[c]).join(' + ');
    return { title: `${label}: ${p.title}`, body: `${Math.round(p.fair * 100)}% to win at ${Math.round(p.cost * 100)}¢, edge +${p.edge.toFixed(1)}. Don't pay over ${p.maxPrice ? Math.round(p.maxPrice * 100) + '¢' : 'the current price'}.` };
  }

  // ------------------------------------------------------------ live scanner (server) support
  snapshot() {
    return { games: this.games, props: this.props, picks: this.picks, updated: this.updated, propsUpdated: this.propsUpdated,
      lastScan: this.lastScan, errors: this.errors, record: this.record(), settings: this.settings };
  }
  applyRemote(s) {
    Object.assign(this, { games: s.games || [], props: s.props || [], picks: s.picks || [], updated: s.updated,
      propsUpdated: s.propsUpdated, lastScan: s.lastScan, errors: s.errors || [], remoteRecord: s.record || null });
  }

  record() {
    if (this.remoteRecord) return this.remoteRecord;
    const S = this.settings, out = {};
    for (const cat of ['safe', 'upside', 'gold']) {
      const rows = this.pickLog.filter((e) => (e.cats || []).includes(cat));
      const settled = rows.filter((e) => e.result === 'win' || e.result === 'loss');
      const closed = rows.filter((e) => isPast(e.kickoff) && e.closePrice != null);
      const clv = closed.map((e) => 100 * (e.closePrice - e.priceAtAlert));
      const pnl = settled.reduce((a, e) => a + (e.result === 'win' ? 1 - e.priceAtAlert : -e.priceAtAlert) - fee(e.priceAtAlert, S), 0);
      const cost = settled.reduce((a, e) => a + e.priceAtAlert, 0);
      const mean = clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null;
      const se = clv.length > 2 ? Math.sqrt(clv.reduce((a, c) => a + (c - mean) ** 2, 0) / (clv.length - 1) / clv.length) : null;
      const buckets = [[0, 30], [30, 45], [45, 55], [55, 70], [70, 85], [85, 101]].map(([lo, hi]) => {
        const b = settled.filter((e) => e.fair * 100 >= lo && e.fair * 100 < hi);
        return b.length ? { range: `${lo}–${Math.min(hi, 100)}%`, n: b.length,
          said: (100 * b.reduce((a, e) => a + e.fair, 0)) / b.length, won: (100 * b.filter((e) => e.result === 'win').length) / b.length } : null;
      }).filter(Boolean);
      out[cat] = { signals: rows.length, settled: settled.length, wins: settled.filter((e) => e.result === 'win').length,
        pnl, roi: cost ? (100 * pnl) / cost : null, clv: mean, clvSe: se, nClv: clv.length,
        beatClose: clv.length ? (100 * clv.filter((c) => c > 0).length) / clv.length : null, calibration: buckets };
    }
    return out;
  }

  // ------------------------------------------------------------ your bets
  async addBet(b) {
    const S = this.settings;
    const bet = { id: `b${Date.now()}`, time: nowIso(), ticker: b.ticker, side: b.side, price: +b.price, contracts: +b.contracts,
      fee: orderFee(+b.contracts, +b.price, S), title: b.title, sub: b.sub, kind: b.kind, game: b.game, fair: b.fair,
      kickoff: b.kickoff, eventTicker: b.eventTicker, status: 'open', closePrice: null, pnl: null, settled: null };
    this.bets.unshift(bet); await this.save('bets'); return bet;
  }
  async deleteBet(id) { this.bets = this.bets.filter((b) => b.id !== id); await this.save('bets'); }
  async voidBet(id) { for (const b of this.bets) if (b.id === id) { b.status = 'void'; b.pnl = 0; } await this.save('bets'); }

  async updateBets() {
    let changed = false;
    for (const b of this.bets) {
      if (b.status !== 'open') continue;
      try {
        const m = (await getJson(`${KALSHI}/markets/${b.ticker}`)).market || {};
        const c = costs(m), now = b.side === 'yes' ? c.yes : c.no;
        const trading = ['open', 'active', 'initialized', 'unopened', ''].includes((m.status || '').toLowerCase());
        if (trading && !isPast(b.kickoff || m.occurrence_datetime) && now != null) b.closePrice = now;
        const res = (m.result || '').toLowerCase();
        if (res === 'yes' || res === 'no') {
          const won = res === b.side;
          b.pnl = +(b.contracts * (won ? 1 - b.price : -b.price) - b.fee).toFixed(2);
          b.status = won ? 'won' : 'lost'; b.settled = nowIso();
        }
        changed = true;
      } catch (e) { /* retry next refresh */ }
    }
    if (changed) await this.save('bets');
  }

  summary() {
    const S = this.settings, today = new Date().toDateString();
    const day = (iso) => (iso ? new Date(iso).toDateString() : null);
    const settled = this.bets.filter((b) => b.status === 'won' || b.status === 'lost');
    const risked = settled.reduce((a, b) => a + b.contracts * b.price + b.fee, 0);
    const pnl = settled.reduce((a, b) => a + b.pnl, 0);
    const clv = this.bets.filter((b) => b.closePrice != null && isPast(b.kickoff)).map((b) => 100 * (b.closePrice - b.price));
    const todayBets = this.bets.filter((b) => day(b.time) === today);
    const todayPnl = this.bets.filter((b) => b.settled && day(b.settled) === today).reduce((a, b) => a + (b.pnl || 0), 0);
    const exposure = {};
    for (const b of this.bets) if (b.status === 'open') exposure[b.game || b.ticker] = (exposure[b.game || b.ticker] || 0) + b.contracts * b.price + b.fee;
    const cap = (S.maxGameExposurePct / 100) * S.bankroll, warnings = [];
    if (-todayPnl >= S.dailyLossLimit) warnings.push(`You've hit today's loss limit ($${S.dailyLossLimit}). Done for today.`);
    if (todayBets.length >= S.maxBetsPerDay) warnings.push(`${todayBets.length} bets today. Your limit is ${S.maxBetsPerDay}.`);
    for (const [k, v] of Object.entries(exposure)) if (v > cap) warnings.push(`$${v.toFixed(0)} riding on one game (${k}), over your ${S.maxGameExposurePct}% cap.`);
    return { pnl, risked, roi: risked ? (100 * pnl) / risked : null, clv: clv.length ? clv.reduce((a, b) => a + b, 0) / clv.length : null,
      beatClose: clv.length ? (100 * clv.filter((c) => c > 0).length) / clv.length : null, nClv: clv.length,
      settled: settled.length, open: this.bets.filter((b) => b.status === 'open').length, todayCount: todayBets.length,
      todayPnl, exposure, warnings };
  }

  // ------------------------------------------------------------ refresh
  async refresh({ props = true, onProgress = () => {} } = {}) {
    if (this.busy) return;
    this.busy = true; const errors = [];
    try {
      onProgress('Checking Sleeper');
      await this.sleeper.refresh(onProgress);
      if (this.sleeper.error) errors.push(this.sleeper.error);
      let games = {};
      try { onProgress('Reading Kalshi games'); games = await this.buildGames(); }
      catch (e) { errors.push(`Kalshi games: ${e.message}`); games = Object.fromEntries(this.games.map((g) => [g.key, g])); }
      this.games = Object.values(games).sort((x, y) => ({ gold: 0, split: 1, quiet: 2 }[x.status] - { gold: 0, split: 1, quiet: 2 }[y.status])
        || (x.kickoff || '').localeCompare(y.kickoff || ''));
      if (props) {
        try { onProgress('Reading Kalshi player props'); this.props = await this.buildProps(games); this.propsUpdated = nowIso(); }
        catch (e) { errors.push(`Kalshi props: ${e.message}`); }
      }
      if (this.odds.error) errors.push(this.odds.error);
      this.picks = this.buildPicks();
      onProgress('Updating your bets');
      await this.updateBets(); await this.logPicks();
      this.updated = nowIso(); this.lastScan = this.updated;
    } finally { this.errors = errors; this.busy = false; onProgress(''); }
  }

  // ------------------------------------------------------------ user inputs
  async setSharpMush(game, side, pctVal) {
    if (pctVal == null || pctVal === '') delete this.sharpmush[game];
    else this.sharpmush[game] = { side, pct: +pctVal, time: nowIso() };
    await this.save('sharpmush');
  }
  async setMyFair(game, probA) {
    if (probA == null || probA === '') delete this.myFair[game]; else this.myFair[game] = +probA;
    await this.save('myFair');
  }
  async setSettings(patch) { this.settings = { ...this.settings, ...patch }; await this.save('settings'); }
}
