# Sharp Side for iPhone

NFL picks from Kalshi prices, Juice Reel's SharpMush, and Sleeper player stats. The app reads public data only. It never logs in to Kalshi and never places bets.

## What you need
- An Apple Developer Program membership (paid, required for TestFlight)
- A free Expo account (expo.dev)
- Any computer with Node.js 20 or newer. A Mac is not required; Expo builds the app in the cloud.

## 1. Make the project
```
npx create-expo-app@latest sharp-side --template blank
cd sharp-side
npx expo install @react-native-async-storage/async-storage react-native-safe-area-context expo-notifications expo-constants
```
Then copy these files into the `sharp-side` folder, replacing the existing `App.js`:
- `App.js`
- the `src` folder
- `eas.json`

## 2. Set your app's name and ID
Open `app.json` and add the fields from `app.json.example`. The important ones:
- `ios.bundleIdentifier`: a unique ID such as `com.yourname.sharpside`
- `ios.config.usesNonExemptEncryption: false`: the app only uses standard HTTPS, and this skips Apple's encryption questions on every upload
- `"plugins": ["expo-notifications"]`: turns on push alerts. During `npx testflight`, say yes when it offers to set up a push notification key.

Leave the icon and splash entries the template created.

## 3. Try it on your phone first (optional, free)
```
npx expo start
```
Scan the QR code with the iPhone camera to open the app in Expo Go. Turn on **Demo data** in Settings to see every screen with made-up markets.

## 4. Send it to TestFlight
```
npx testflight
```
This walks you through signing in to Expo and Apple, builds the app in the cloud, and submits it to TestFlight. When Apple finishes processing the build (usually under an hour), open App Store Connect → your app → TestFlight. Add yourself as an internal tester, then install the build from the TestFlight app.

To ship an update later, run `npx testflight` again. The build number goes up automatically.

Internal testers (people on your App Store Connect team) don't need Apple review. External testers need Beta App Review, and Apple looks closely at betting-related apps.

## 5. Live scanning every 10 minutes
**In the app:** Sharp Side scans every 10 minutes while it's open (change this under Settings → Scanning). It shows a notification when a new pick appears.

**Around the clock:** iPhone apps can't wake themselves every 10 minutes; iOS decides when background work runs. For real 24/7 scanning, run the small scanner in the `server` folder on any always-on host. It runs the same pick engine, scans every 10 minutes, and sends push alerts to your phone even when it's locked.

### Option A: any always-on server
To deploy the scanner:
1. Put the `server` folder in a GitHub repo (it already contains its own copy of the engine in `server/lib`).
2. Create a Node.js service from it on a host that stays on, such as Railway, Render (a paid instance; free ones go to sleep), Fly.io, or a computer at home. Use Node 20+ and the start command `npm start`.
3. Set these environment variables:
   - `SCANNER_KEY`: a long random password (16+ characters)
   - `DATA_DIR`: optional, a persistent disk path so pick history survives redeploys
   - `SCAN_MINUTES`: optional, default `10`
4. Give the service a public `https://` address.
5. In the app, go to Settings → Live scanner, enter the address and key, and tap **Connect and turn on alerts**.

### Option B: Vercel (Cron every 10 minutes)
The `scanner-vercel` folder is the same scanner built for Vercel.
- `vercel.json` has a cron that calls `/api/agent/pulse` every 10 minutes (`*/10 * * * *`).
- Each pulse does three things:
  1. Scans Kalshi, Sleeper and the Odds API.
  2. Sends push alerts for new picks.
  3. Does upkeep: refreshes cached Sleeper data, drops old trades, settles finished picks, prunes the pick log, and writes a heartbeat.

**Plan:** Vercel's Hobby plan only allows cron jobs once a day, and a 10-minute schedule fails at deploy time. Use Pro, or stay on Hobby and use an outside scheduler (step 6).

1. Put the `scanner-vercel` folder in a GitHub repo and import it as a new Vercel project.
2. Add storage: in the project, open Storage (Marketplace) → Upstash Redis → connect it. This adds the Redis URL and token variables automatically.
3. Add environment variables:
   - `SCANNER_KEY`: a long random password the app will use
   - `CRON_SECRET`: a different random string, 16+ characters. Vercel sends it with every cron call.
4. Deploy. In Settings → Cron Jobs you should see `/api/agent/pulse` every 10 minutes.
5. In the app, go to Settings → Live scanner, enter `https://your-project.vercel.app` and your `SCANNER_KEY`, then tap **Connect and turn on alerts**.
6. Hobby plan only: delete the `crons` block from `vercel.json`. Then have a free outside scheduler (for example cron-job.org or Crontap) call `https://your-project.vercel.app/api/agent/pulse` every 10 minutes, with the header `Authorization: Bearer <your CRON_SECRET>`.

Check it at `https://your-project.vercel.app/health`. It returns 200 with the last pulse time, or 503 if no pulse has run in 25 minutes.

`vercel.json` asks for up to 300 seconds per run. The first pulse loads Sleeper's season stats and is the slowest; later pulses use the cache in Redis. If your plan caps function time lower, Vercel will say so when you deploy.

If you change files in `src`, run `npm run sync` inside `scanner-vercel` and redeploy.

Your SharpMush entries, fair prices and settings sync to the scanner when you save them. Your logged bets stay on your phone.

Push alerts need the TestFlight build. Expo Go can't receive them.

Check that the scanner is up by opening `https://your-scanner/health`. It shows the last and next scan times.

To try it on your computer first, run:
```
cd server
SCANNER_KEY=some-long-test-key-123 npm run demo
```

If you change files in `src`, run `npm run sync` inside `server` so the scanner gets the same changes.

## First launch
- The first refresh loads this season's stats from Sleeper and takes a minute or two. After that, stats are cached on the phone.
- Without a scanner, the app scans every 10 minutes while it's open, plus whenever you pull down. With a scanner connected, it shows the scanner's latest results and you get alerts around the clock.
- Optional: paste a free key from the-odds-api.com in Settings to get Pinnacle fair prices for game winners. Without it, type your own fair % on a game. The free plan allows 500 credits a month, so the app pulls odds every 90 minutes, not every scan. On a paid plan, lower "Pull Odds API every" in Settings.
- SharpMush comes from the Juice Reel app. Type the % on each game card. It counts as stale after 12 hours.

## How picks work
- **Likely wins:** at least a 70% chance by the app's numbers, priced at least 2.5 points in your favor after fees. Player props need 4+ games of history or a Sleeper projection. Small payouts, so one loss can wipe out several wins.
- **Upside:** Kalshi price of 45¢ or less (pays about 2.2x or more) and an edge of 6+ points. SharpMush or Kalshi big money must agree. These lose more often than they win.
- **Signals agree:** value plus SharpMush for games, or value plus Kalshi big money for props.
- **Check news:** edges over 15 points. These usually mean the market knows about an injury or role change that the stats don't show yet.

Every pick shows a "don't pay more than" price. Posting a limit order at or under it pays Kalshi's lower maker fee.

All thresholds are in Settings.

## Know your numbers
The **Signal record** tab paper-trades every pick at 1 contract and shows each category's results. It reports:
- **Closing line value (CLV):** your price compared with Kalshi's last price before kickoff.
- **Calibration:** when the app said 70%, how often it actually won.

Wait for a few hundred picks before trusting a category. CLV shows real skill sooner than profit does.

## Files
- `App.js`: the screens
- `src/engine.js`: picks, categories, bet tracking, record
- `src/sleeper.js`: player stats and the prop model
- `src/tape.js`: Kalshi trade feed and big-money signal
- `src/util.js`, `src/config.js`: math, team names, default settings
- `src/demo.js`: made-up data for demo mode
- `server/scanner.js`: the 24/7 scanner for an always-on server (`server/lib` is a copy of `src`)
- `scanner-vercel/`: the same scanner for Vercel. `api/agent/pulse.js` is the 10-minute cron job, and `lib/core.js` handles storage, push alerts and locking.
