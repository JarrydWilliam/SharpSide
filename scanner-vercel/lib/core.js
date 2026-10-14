// Shared code for the Vercel functions: storage, auth, the pulse job, push alerts.
import { Engine } from './engine/engine.js';
import { setFetch } from './engine/api.js';
import { makeDemoFetch } from './engine/demo.js';

const P = 'ss:';   // key prefix in Redis
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const DEMO = !!process.env.DEMO;
if (DEMO) setFetch(makeDemoFetch());

// ---------------------------------------------------------------- storage: Upstash Redis REST, or memory for local tests
const mem = globalThis.__ssMem || (globalThis.__ssMem = new Map());
async function redis(cmd) {
  if (!REDIS_URL) {                       // local testing only: nothing survives a restart
    const [op, k, v, ...rest] = cmd;
    if (op === 'GET') return mem.get(k) ?? null;
    if (op === 'SET') { if (rest.includes('NX') && mem.has(k)) return null; mem.set(k, v); return 'OK'; }
    if (op === 'DEL') { mem.delete(k); return 1; }
    return null;
  }
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(cmd) });
  const out = await r.json();
  if (out.error) throw new Error(`Redis: ${out.error}`);
  return out.result;
}
export const storage = {
  get: async (k) => { const v = await redis(['GET', P + k]); return v == null ? null : JSON.parse(v); },
  set: async (k, v) => { await redis(['SET', P + k, JSON.stringify(v)]); },
};
export const lock = async (name, seconds) => (await redis(['SET', `${P}lock:${name}`, String(Date.now()), 'NX', 'EX', seconds])) === 'OK';
export const unlock = (name) => redis(['DEL', `${P}lock:${name}`]);

// ---------------------------------------------------------------- auth
const header = (req, k) => req.headers?.[k] ?? req.headers?.get?.(k);
/** Vercel Cron (or an outside scheduler) sends Authorization: Bearer CRON_SECRET. */
export const isCron = (req) => !!process.env.CRON_SECRET && header(req, 'authorization') === `Bearer ${process.env.CRON_SECRET}`;
/** The app sends x-scanner-key: SCANNER_KEY. */
export const isApp = (req) => !!process.env.SCANNER_KEY && header(req, 'x-scanner-key') === process.env.SCANNER_KEY;

export async function loadEngine() {
  const e = new Engine(storage);
  await e.load();
  if (DEMO && !e.settings.oddsApiKey) e.settings.oddsApiKey = 'demo';
  return e;
}
export function nextPulse() {   // the next 10-minute mark, for the app's "next scan in" line
  const ms = 10 * 6e4; return new Date(Math.ceil((Date.now() + 1000) / ms) * ms).toISOString();
}

// ---------------------------------------------------------------- push (Expo push service)
async function push(picks, tokens) {
  const report = { sent: 0, removed: 0, errors: 0 };
  if (!tokens.length || !picks.length) return { report, tokens };
  const top = picks.slice(0, 5), messages = [];
  for (const to of tokens) {
    for (const p of top) messages.push({ to, sound: 'default', ...Engine.alertText(p), data: { id: p.id } });
    if (picks.length > top.length) messages.push({ to, title: `${picks.length - top.length} more new picks`, body: 'Open Sharp Side to see them all.' });
  }
  let keep = [...tokens];
  for (let i = 0; i < messages.length; i += 100) {
    try {
      const r = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(messages.slice(i, i + 100)) });
      const out = await r.json();
      (out.data || []).forEach((t, j) => {
        if (t.status === 'ok') report.sent++;
        else if (t.details?.error === 'DeviceNotRegistered') { keep = keep.filter((x) => x !== messages[i + j].to); report.removed++; }
        else report.errors++;
      });
    } catch { report.errors++; }
  }
  return { report, tokens: keep };
}

// ---------------------------------------------------------------- the pulse: one scan plus upkeep
export async function runPulse(reason) {
  const started = Date.now();
  // A scan can run longer than usual (first Sleeper load); never let two overlap.
  if (!(await lock('pulse', 290))) return { ok: true, skipped: 'previous pulse still running' };
  try {
    const e = await loadEngine();
    // Task 1: scan Kalshi, Sleeper and the Odds API and build picks. Engine.refresh also does the
    // scraper upkeep: refreshes cached Sleeper weeks and projections, drops trades older than the
    // lookback, settles finished picks and prunes the pick log.
    await e.refresh({ props: true });
    // Task 2: alert phones about picks that are new since the last pulse.
    const tokens = (await storage.get('pushTokens')) || [];
    const { report, tokens: kept } = await push(e.newPicks, tokens);
    if (kept.length !== tokens.length) await storage.set('pushTokens', kept);
    // Task 3: save what the app reads, plus a heartbeat.
    await storage.set('snapshot', { ...e.snapshot(), nextScan: nextPulse(), devices: kept.length });
    const beat = { reason, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000),
      games: e.games.length, props: e.props.length, picks: e.picks.length, newPicks: e.newPicks.length, push: report, errors: e.errors };
    await storage.set('heartbeat', beat);
    return { ok: true, ...beat };
  } finally { await unlock('pulse'); }
}
