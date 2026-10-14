import { SLEEPER, STATS, STATS_WANTED, SCRIPT } from './config.js';
import { getJson } from './api.js';
import { normName, normalAtLeast, poissonAtLeast } from './util.js';

const DAY = 864e5;
const slim = (st) => { const o = {}; for (const k of STATS_WANTED) if (st[k] != null) o[k] = st[k]; return o; };
const played = (st) => (st.gp || 0) > 0 || (st.off_snp || 0) > 0 || ['rec_yd', 'rush_att', 'pass_att', 'rec'].some((k) => (st[k] || 0) > 0);
export const statValue = (st, stat) => STATS[stat].keys.reduce((a, k) => a + (+st?.[k] || 0), 0);

/** Player list, weekly stats and projections from Sleeper, cached on the phone. */
export class SleeperData {
  constructor(storage) {
    this.storage = storage; this.players = {}; this.index = {}; this.logs = {}; this.proj = {};
    this.season = null; this.week = null; this.stateAt = 0; this.projAt = 0; this.weeks = {}; this.error = null;
  }
  async cached(key, maxAgeMs, load) {
    const c = await this.storage.get(key);
    if (c && Date.now() - c.t < maxAgeMs) return c.data;
    const data = await load();
    await this.storage.set(key, { t: Date.now(), data });
    return data;
  }
  async refresh(onProgress = () => {}) {
    try {
      if (!this.season || Date.now() - this.stateAt > 36e5) {
        const st = await getJson(`${SLEEPER}/state/nfl`);
        const type = st.season_type || 'regular';
        this.season = +st.season; this.stateAt = Date.now();
        this.week = type === 'regular' ? +st.week || 1 : type === 'pre' ? 1 : 19;
        this.seasonType = type;
      }
      // Sleeper asks apps to pull the full player list at most once a day.
      if (!Object.keys(this.players).length || Date.now() - (this.playersAt || 0) > DAY) {
        onProgress('Loading player list');
        this.players = await this.cached('sleeper_players', DAY, async () => {
          const raw = await getJson(`${SLEEPER}/players/nfl`); const keep = {};
          for (const [pid, p] of Object.entries(raw || {})) {
            if (!['QB', 'RB', 'WR', 'TE', 'FB'].includes(p.position)) continue;
            keep[pid] = { name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(), team: p.team,
              pos: p.position, inj: p.injury_status || null, status: p.status || null };
          }
          return keep;
        });
        this.playersAt = Date.now();
        this.index = {};
        for (const [pid, p] of Object.entries(this.players)) (this.index[normName(p.name)] ||= []).push(pid);
      }
      // This season's finished weeks, plus the back half of last season for players with few games.
      const wanted = [];
      for (let w = 1; w < Math.min(this.week, 19); w++) wanted.push([this.season, w]);
      for (let w = 10; w <= 18; w++) wanted.push([this.season - 1, w]);
      let changed = false;
      for (const [s, w] of wanted) {
        const k = `stats_${s}_${w}`;
        const latest = s === this.season && w === this.week - 1;      // stat corrections land on the latest week
        if (this.weeks[k] && !(latest && Date.now() - this.weeks[k].t > 6 * 36e5)) continue;
        onProgress(`Loading ${s} week ${w} stats`);
        const data = await this.cached(k, latest ? 6 * 36e5 : 365 * DAY, async () => {
          const raw = await getJson(`${SLEEPER}/stats/nfl/regular/${s}/${w}`); const o = {};
          for (const [pid, st] of Object.entries(raw || {})) if (this.players[pid] && st && typeof st === 'object') o[pid] = slim(st);
          return o;
        });
        this.weeks[k] = { t: Date.now(), s, w, data }; changed = true;
      }
      if (changed) {
        const logs = {};
        for (const { s, w, data } of Object.values(this.weeks))
          for (const [pid, st] of Object.entries(data)) if (played(st)) (logs[pid] ||= []).push([s, w, st]);
        this.logs = logs;
      }
      if (this.seasonType === 'regular' && Date.now() - this.projAt > 6 * 36e5) {
        onProgress('Loading projections');
        const raw = await getJson(`${SLEEPER}/projections/nfl/regular/${this.season}/${this.week}`);
        this.proj = {};
        for (const [pid, st] of Object.entries(raw || {})) if (this.players[pid] && st && typeof st === 'object') this.proj[pid] = slim(st);
        this.projAt = Date.now();
      }
      this.error = null;
    } catch (e) { this.error = `Sleeper: ${e.message}`; }
  }

  match(name, teams) {
    let c = this.index[normName(name)] || [];
    if (!c.length) {
      const k = normName(name).replace(/ /g, '');
      for (const [n, ids] of Object.entries(this.index)) if (n.replace(/ /g, '') === k) c = c.concat(ids);
    }
    if (c.length > 1 && teams) { const on = c.filter((p) => teams.includes(this.players[p].team)); if (on.length) c = on; }
    return c[0] || null;
  }

  recencyWeight(s, w) { return s !== this.season ? 0.4 : w >= this.week - 4 ? 1 : 0.75; }

  roleTrend(logs) {
    const cur = logs.filter(([s, , st]) => s === this.season && st.tm_off_snp).sort((a, b) => a[1] - b[1]);
    if (cur.length < 5) return null;
    const share = (rows) => rows.reduce((a, r) => a + (r[2].off_snp || 0), 0) / Math.max(1, rows.reduce((a, r) => a + (r[2].tm_off_snp || 0), 0));
    const recent = share(cur.slice(-3)), before = share(cur.slice(0, -3));
    if (before <= 0) return null;
    const change = recent / before - 1;
    return { recent, before, change, flag: change >= 0.2 ? 'up' : change <= -0.2 ? 'down' : null };
  }

  /** Fair chance of "N+": weighted hit rate blended with a distribution model. */
  fair(pid, stat, line, winProb) {
    let logs = this.logs[pid] || [];
    const role = this.roleTrend(logs);
    if (role?.flag) logs = logs.filter(([s]) => s === this.season);   // role changed: old games mislead
    const vals = logs.map(([s, w, st]) => [this.recencyWeight(s, w), statValue(st, stat)]);
    const nEff = vals.reduce((a, [w]) => a + w, 0);
    const proj = this.proj[pid];
    const projMean = proj && STATS[stat].keys.some((k) => proj[k] != null) ? statValue(proj, stat) : null;
    if (nEff < 1 && projMean == null) return null;
    const histMean = nEff ? vals.reduce((a, [w, v]) => a + w * v, 0) / nEff : null;
    let mean, source, script = 0;
    if (projMean != null) { mean = projMean; source = 'Sleeper projection'; }
    else {
      mean = histMean; source = 'recent games';
      if (winProb != null && SCRIPT[stat]) { script = SCRIPT[stat] * (winProb - 0.5) * 2; mean *= 1 + script; }
    }
    const v = nEff >= 2 ? vals.reduce((a, [w, x]) => a + w * (x - histMean) ** 2, 0) / nEff : 0;
    const sd = Math.max(Math.sqrt(v), STATS[stat].sdFloor || 1, 0.35 * mean);
    const model = STATS[stat].kind === 'poisson' ? poissonAtLeast(line, mean) : normalAtLeast(line, mean, sd);
    const hits = vals.reduce((a, [w, x]) => a + (x >= line ? w : 0), 0);
    const emp = nEff ? (hits + model) / (nEff + 1) : model;
    const wt = nEff / (nEff + 8);
    return {
      fair: Math.min(0.97, Math.max(0.03, wt * emp + (1 - wt) * model)),
      games: logs.filter(([s]) => s === this.season).length, gamesLast: logs.filter(([s]) => s !== this.season).length,
      hitRate: nEff ? hits / nEff : null, mean: +mean.toFixed(1), sd: +sd.toFixed(1), source,
      script: script ? +(100 * script).toFixed(1) : null, role, hasProjection: projMean != null,
    };
  }
}
