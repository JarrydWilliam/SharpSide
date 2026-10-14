import { storage, isApp, nextPulse } from '../lib/core.js';

export default async function handler(req, res) {
  if (!isApp(req)) return res.status(401).json({ error: 'Wrong or missing scanner key' });
  const snap = await storage.get('snapshot');
  if (!snap) return res.status(200).json({ games: [], props: [], picks: [], errors: ['No scan yet. The first one runs within 10 minutes.'], nextScan: nextPulse() });
  res.status(200).json({ ...snap, nextScan: nextPulse() });
}
