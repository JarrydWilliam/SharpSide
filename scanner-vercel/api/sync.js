// The app saves SharpMush entries, fair prices and settings here, then the next pulse uses them.
import { storage, isApp, loadEngine } from '../lib/core.js';

export default async function handler(req, res) {
  if (!isApp(req)) return res.status(401).json({ error: 'Wrong or missing scanner key' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const e = await loadEngine();
  if (b.settings) {
    const patch = {};
    for (const [k, v] of Object.entries(b.settings)) if (k in e.settings && !['scannerUrl', 'scannerKey', 'demo'].includes(k)) patch[k] = v;
    await e.setSettings(patch);
  }
  if (b.sharpmush && typeof b.sharpmush === 'object') await storage.set('sharpmush', b.sharpmush);
  if (b.myFair && typeof b.myFair === 'object') await storage.set('myFair', b.myFair);
  res.status(200).json({ ok: true, note: 'Saved. The next scan uses these.' });
}
