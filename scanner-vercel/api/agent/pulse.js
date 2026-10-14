// Vercel Cron calls this every 10 minutes (see vercel.json). An outside scheduler can too,
// with the header Authorization: Bearer <CRON_SECRET>.
import { runPulse, isCron, isApp } from '../../lib/core.js';

export default async function handler(req, res) {
  if (!isCron(req) && !isApp(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { res.status(200).json(await runPulse(isCron(req) ? 'cron' : 'app')); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
