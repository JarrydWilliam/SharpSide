// Sharp Side live scanner: runs the same engine as the app, around the clock.
//   SCANNER_KEY   required. A long random password; the app sends it with every request.
//   SCAN_MINUTES  optional, default 10.
//   PORT          optional, default 8080 (most hosts set this for you).
//   DATA_DIR      optional, default ./data. Point it at a persistent volume to keep history across deploys.
//   DEMO=1        optional, made-up data for testing.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Engine } from './lib/engine.js';
import { setFetch } from './lib/api.js';
import { makeDemoFetch } from './lib/demo.js';

const KEY = process.env.SCANNER_KEY;
const PORT = +process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || path.resolve('data');
const DEMO = !!process.env.DEMO;
if (!KEY || KEY.length < 16) { console.error('Set SCANNER_KEY to a random string of at least 16 characters.'); process.exit(1); }
await fs.mkdir(DATA, { recursive: true });

const storage = {
  get: async (k) => { try { return JSON.parse(await fs.readFile(path.join(DATA, `${k}.json`), 'utf8')); } catch { return null; } },
  set: async (k, v) => { const p = path.join(DATA, `${k}.json`); await fs.writeFile(p + '.tmp', JSON.stringify(v)); await fs.rename(p + '.tmp', p); },
};
if (DEMO) setFetch(makeDemoFetch());
const engine = new Engine(storage);
await engine.load();
if (DEMO) await engine.setSettings({ oddsApiKey: engine.settings.oddsApiKey || 'demo', demo: true });
let tokens = (await storage.get('pushTokens')) || [];
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- push notifications (Expo push service)
async function push(picks) {
  if (!tokens.length || !picks.length) return;
  const top = picks.slice(0, 5);
  const messages = [];
  for (const to of tokens) {
    for (const p of top) messages.push({ to, sound: 'default', ...Engine.alertText(p), data: { id: p.id } });
    if (picks.length > top.length) messages.push({ to, title: `${picks.length - top.length} more new picks`, body: 'Open Sharp Side to see them all.' });
  }
  for (let i = 0; i < messages.length; i += 100) {
    try {
      const r = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(messages.slice(i, i + 100)) });
      const out = await r.json();
      (out.data || []).forEach((t, j) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') tokens = tokens.filter((x) => x !== messages[i + j].to);
        else if (t.status === 'error') log('push error', t.message);
      });
    } catch (e) { log('push failed', e.message); }
  }
  await storage.set('pushTokens', tokens);
}

// ---------------------------------------------------------------- scan loop
let scanning = false, nextScan = null;
async function scan(reason) {
  if (scanning) return;
  scanning = true; const t0 = Date.now();
  try {
    await engine.refresh({ props: true });
    log(`scan (${reason}) ${((Date.now() - t0) / 1000).toFixed(0)}s: ${engine.games.length} games, ${engine.props.length} props, ` +
      `${engine.picks.length} picks, ${engine.newPicks.length} new${engine.errors.length ? ' | ' + engine.errors.join('; ') : ''}`);
    await push(engine.newPicks);
  } catch (e) { log('scan failed', e.message); }
  finally { scanning = false; }
}
function schedule() {
  const mins = Math.max(2, +process.env.SCAN_MINUTES || engine.settings.scanMinutes || 10);
  nextScan = new Date(Date.now() + mins * 6e4).toISOString();
  setTimeout(async () => { await scan('timer'); schedule(); }, mins * 6e4);
}

// ---------------------------------------------------------------- tiny API for the app
const ALLOWED = new Set(Object.keys(engine.settings));
const readBody = (req) => new Promise((res, rej) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); req.on('error', rej);
});
const send = (res, code, obj) => { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };

http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { ok: true, lastScan: engine.lastScan, nextScan, scanning });
    if (req.headers['x-scanner-key'] !== KEY) return send(res, 401, { error: 'Wrong or missing scanner key' });
    if (req.method === 'GET' && req.url === '/state') return send(res, 200, { ...engine.snapshot(), nextScan, scanning, devices: tokens.length });
    if (req.method === 'POST' && req.url === '/register') {
      const { token } = await readBody(req);
      if (!/^Expo(nent)?PushToken\[.+\]$/.test(token || '')) return send(res, 400, { error: 'Not an Expo push token' });
      if (!tokens.includes(token)) { tokens.push(token); await storage.set('pushTokens', tokens); }
      return send(res, 200, { ok: true, devices: tokens.length });
    }
    if (req.method === 'POST' && req.url === '/sync') {
      const b = await readBody(req);
      if (b.settings) {
        const patch = {};
        for (const [k, v] of Object.entries(b.settings)) if (ALLOWED.has(k) && !['scannerUrl', 'scannerKey', 'demo'].includes(k)) patch[k] = v;
        await engine.setSettings(patch);
      }
      if (b.sharpmush && typeof b.sharpmush === 'object') { engine.sharpmush = b.sharpmush; await engine.save('sharpmush'); }
      if (b.myFair && typeof b.myFair === 'object') { engine.myFair = b.myFair; await engine.save('myFair'); }
      scan('sync');   // rescan with the new inputs, answer right away
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/scan') { scan('manual'); return send(res, 200, { ok: true }); }
    send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, () => log(`Sharp Side scanner on :${PORT}${DEMO ? ' (DEMO data)' : ''}`));

await scan('startup');
schedule();
