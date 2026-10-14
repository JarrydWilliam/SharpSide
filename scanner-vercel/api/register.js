import { storage, isApp } from '../lib/core.js';

export default async function handler(req, res) {
  if (!isApp(req)) return res.status(401).json({ error: 'Wrong or missing scanner key' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (!/^Expo(nent)?PushToken\[.+\]$/.test(b.token || '')) return res.status(400).json({ error: 'Not an Expo push token' });
  const tokens = (await storage.get('pushTokens')) || [];
  if (!tokens.includes(b.token)) { tokens.push(b.token); await storage.set('pushTokens', tokens); }
  res.status(200).json({ ok: true, devices: tokens.length });
}
