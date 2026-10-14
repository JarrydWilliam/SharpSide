// Public: shows whether the 10-minute pulse is running. No picks or settings are exposed.
import { storage, nextPulse } from '../lib/core.js';

export default async function handler(req, res) {
  const beat = await storage.get('heartbeat');
  const stale = !beat || Date.now() - Date.parse(beat.at) > 25 * 6e4;
  res.status(stale ? 503 : 200).json({ ok: !stale, lastPulse: beat?.at || null, seconds: beat?.seconds, picks: beat?.picks,
    newPicks: beat?.newPicks, errors: beat?.errors?.length || 0, nextPulse: nextPulse() });
}
