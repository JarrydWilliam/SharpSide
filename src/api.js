// Network helper: polite spacing between calls, retries on rate limits. fetch can be swapped for demo mode.
let fetchImpl = (...a) => fetch(...a);
export const setFetch = (f) => { fetchImpl = f; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
const throttle = () => (queue = queue.then(() => sleep(80)));
const host = (url) => (url.match(/^https?:\/\/([^/]+)/) || [])[1] || url;

export async function getJson(url, params) {
  if (params) {
    const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  }
  let lastErr;
  for (let i = 0; i < 4; i++) {
    await throttle();
    try {
      const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if ([429, 500, 502, 503].includes(r.status) && i < 3) { await sleep(1000 * 2 ** i); continue; }
      if (!r.ok) throw new Error(`${host(url)} answered ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < 3 && !/answered/.test(e.message)) { await sleep(800 * (i + 1)); continue; }
      throw e;
    }
  }
  throw lastErr;
}
