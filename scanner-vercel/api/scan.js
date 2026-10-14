// "Scan now" from the app's pull-to-refresh.
import { runPulse, isApp } from '../lib/core.js';

export default async function handler(req, res) {
  if (!isApp(req)) return res.status(401).json({ error: 'Wrong or missing scanner key' });
  try { res.status(200).json(await runPulse('manual')); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
