import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, Modal, Switch, RefreshControl, AppState, Linking,
  StyleSheet, useColorScheme, KeyboardAvoidingView, Platform, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Engine } from './src/engine.js';
import { setFetch } from './src/api.js';
import { makeDemoFetch } from './src/demo.js';
import { cents, pct, usd, shortTeam } from './src/util.js';

// ------------------------------------------------------------------ theme
const LIGHT = { bg: '#E9EDF2', card: '#FFFFFF', ink: '#13203A', muted: '#5B6880', line: '#D3DAE4', money: '#2457D6',
  value: '#0E8A62', best: '#7A3FD1', gold: '#C98A00', goldWash: '#FFF4D1', split: '#C24E12', neg: '#B4233A', safe: '#0E7490', upside: '#9333EA', chip: '#EEF1F5' };
const DARK = { bg: '#0B121E', card: '#141E30', ink: '#E7ECF5', muted: '#93A0B8', line: '#26344D', money: '#6E95FF',
  value: '#34C48C', best: '#B48CFF', gold: '#F2B630', goldWash: '#2C2410', split: '#FF8A4C', neg: '#FF6B81', safe: '#38BDF8', upside: '#C084FC', chip: '#1C2840' };

const CAT = {
  safe: { label: 'Likely wins', blurb: 'At least a 70% chance by our numbers, still priced in your favor. Small payouts: one loss can erase several wins.' },
  upside: { label: 'Upside', blurb: 'Pays about 2x or more, has a bigger edge, and SharpMush or Kalshi big money agrees. Expect to lose more often than you win.' },
  gold: { label: 'Signals agree', blurb: 'Value and the money signal point the same way (SharpMush for games, Kalshi big money for props).' },
};

// Show alerts even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Talk to the live scanner server, if one is set up in Settings. */
async function scanner(s, path, body) {
  const url = (s.scannerUrl || '').trim().replace(/\/+$/, '');
  const r = await fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-scanner-key': (s.scannerKey || '').trim() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Scanner answered ${r.status}`);
  return data;
}
const remoteOn = (s) => !!(s.scannerUrl && s.scannerKey);
async function syncScanner(e) {
  if (!remoteOn(e.settings)) return;
  try { await scanner(e.settings, '/sync', { settings: e.settings, sharpmush: e.sharpmush, myFair: e.myFair }); }
  catch (err) { e.errors = [...e.errors, `Live scanner sync: ${err.message}`]; }
}
async function enableAlerts(e) {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') throw new Error('Notifications are off for Sharp Side. Turn them on in iPhone Settings → Notifications.');
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) throw new Error('Push alerts work in the TestFlight build (run npx testflight first), not in Expo Go.');
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await scanner(e.settings, '/register', { token });
  await syncScanner(e);
  return token;
}

const storage = {
  get: async (k) => { try { const v = await AsyncStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set: async (k, v) => { try { await AsyncStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const ago = (iso) => { if (!iso) return 'never'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const kalshiUrl = (ev) => `https://kalshi.com/markets/kxnflgame/nfl-game/${(ev || '').toLowerCase().replace(/^kxnfl[a-z]+-/, 'kxnflgame-')}`;

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

function Main() {
  const C = useColorScheme() === 'dark' ? DARK : LIGHT;
  const st = useMemo(() => makeStyles(C), [C]);
  const insets = useSafeAreaInsets();
  const eng = useRef(null);
  const [, setTick] = useState(0);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState('');
  const [tab, setTab] = useState('picks');
  const [betDraft, setBetDraft] = useState(null);
  const rerender = () => setTick((t) => t + 1);
  const lastProps = useRef(0);

  const lastLocal = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const e = eng.current; if (!e || e.busy) return;
    if (remoteOn(e.settings)) {
      // Live scanner does the work every 10 min; the phone just reads results and tracks your bets.
      try {
        setProgress('Getting picks from your live scanner');
        if (force) await scanner(e.settings, '/scan', {}).catch(() => {});
        const state = await scanner(e.settings, '/state');
        e.applyRemote(state); e.remoteNext = state.nextScan; e.remoteDevices = state.devices;
        await e.updateBets();
      } catch (err) { e.errors = [`Live scanner: ${err.message}. Check the address and key in Settings.`]; }
      setProgress(''); rerender(); return;
    }
    const due = Date.now() - lastLocal.current >= e.settings.scanMinutes * 60e3;
    if (!force && !due) return;
    await e.refresh({ props: true, onProgress: (p) => setProgress(p) });
    lastLocal.current = Date.now();
    for (const p of e.newPicks.slice(0, 3)) Notifications.scheduleNotificationAsync({ content: Engine.alertText(p), trigger: null }).catch(() => {});
    rerender();
  }, []);

  useEffect(() => {
    (async () => {
      const e = new Engine(storage); await e.load();
      if (e.settings.demo) setFetch(makeDemoFetch());
      eng.current = e; setReady(true); refresh(true);
      if (!remoteOn(e.settings)) Notifications.requestPermissionsAsync().catch(() => {});
    })();
    // Check every minute; local mode scans when scanMinutes have passed, scanner mode reads the latest results.
    const timer = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 60e3);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [refresh]);

  if (!ready) return <View style={[st.fill, st.center]}><ActivityIndicator /></View>;
  const e = eng.current, sum = e.summary();
  const TABS = [['picks', 'Picks'], ['games', 'Games'], ['props', 'Props'], ['bets', 'My bets'], ['settings', 'Settings']];

  return (
    <View style={[st.fill, { paddingTop: insets.top }]}>
      <StatusBar style="auto" />
      <View style={st.header}>
        <Text style={st.brand}>Sharp Side</Text>
        <Text style={st.muted}>{progress || (remoteOn(e.settings)
          ? `Live scanner: scanned ${ago(e.lastScan)}${e.remoteNext ? `, next in ${Math.max(0, Math.round((Date.parse(e.remoteNext) - Date.now()) / 6e4))} min` : ''}`
          : `Scans every ${e.settings.scanMinutes} min while open. Updated ${ago(e.updated)}`)}{e.settings.demo && !remoteOn(e.settings) ? '  ·  DEMO DATA' : ''}</Text>
      </View>
      {e.errors.length > 0 && <View style={st.errBox}><Text style={st.errText}>{e.errors.join('\n')}</Text></View>}
      {sum.warnings.map((w) => <View key={w} style={st.warnBox}><Text style={st.warnText}>{w}</Text></View>)}
      <ScrollView style={st.fill} contentContainerStyle={{ padding: 14, paddingBottom: 30 }} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={!!progress} onRefresh={() => refresh(true)} />}>
        {tab === 'picks' && <Picks e={e} st={st} C={C} onBet={setBetDraft} />}
        {tab === 'games' && <Games e={e} st={st} C={C} onChange={() => { rerender(); refresh(); }} />}
        {tab === 'props' && <Props e={e} st={st} C={C} onBet={setBetDraft} />}
        {tab === 'bets' && <Bets e={e} st={st} C={C} sum={sum} onChange={rerender} />}
        {tab === 'settings' && <Settings e={e} st={st} C={C} onSaved={async (demoChanged) => {
          if (demoChanged) { setFetch(e.settings.demo ? makeDemoFetch() : (...a) => fetch(...a)); }
          rerender(); refresh(true);
        }} />}
      </ScrollView>
      <View style={[st.tabbar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map(([k, label]) => (
          <Pressable key={k} onPress={() => setTab(k)} style={st.tabBtn} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
            <Text style={[st.tabText, tab === k && st.tabOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <BetModal draft={betDraft} st={st} C={C} onClose={() => setBetDraft(null)} onSave={async (b) => { await e.addBet(b); setBetDraft(null); rerender(); }} />
    </View>
  );
}

// ------------------------------------------------------------------ Picks
function Picks({ e, st, C, onBet }) {
  const [cat, setCat] = useState('safe');
  const list = e.picks.filter((p) => p.cats.includes(cat))
    .sort((a, b) => (cat === 'safe' ? b.fair - a.fair : b.edge / b.cost - a.edge / a.cost));
  const checks = e.picks.filter((p) => p.cats.includes('check'));
  return (
    <View>
      <Segmented st={st} value={cat} onChange={setCat} options={Object.entries(CAT).map(([k, v]) => [k, `${v.label} (${e.picks.filter((p) => p.cats.includes(k)).length})`])} />
      <Text style={[st.muted, { marginVertical: 10 }]}>{CAT[cat].blurb}</Text>
      {list.length === 0 && <Empty st={st} text={e.updated ? 'Nothing qualifies right now. That is normal: most of the time the market is fair. Check back after injury news or closer to kickoff.' : 'Loading markets…'} />}
      {list.map((p) => <PickCard key={p.id} p={p} st={st} C={C} onBet={onBet} />)}
      {checks.length > 0 && cat === 'safe' && (
        <View style={{ marginTop: 18 }}>
          <Text style={st.h2}>Check before betting ({checks.length})</Text>
          <Text style={[st.muted, { marginBottom: 8 }]}>These edges look too good. Usually the market knows something the stats don't, like an injury or a role change. Look for news first.</Text>
          {checks.map((p) => <PickCard key={p.id} p={p} st={st} C={C} onBet={onBet} />)}
        </View>
      )}
    </View>
  );
}

function PickCard({ p, st, C, onBet }) {
  const tagColor = { safe: C.safe, upside: C.upside, gold: C.gold, check: C.split };
  const tagText = { safe: 'Likely win', upside: 'Upside', gold: 'Signals agree', check: 'Check news' };
  return (
    <View style={[st.card, p.cats.includes('gold') && { borderColor: C.gold, borderWidth: 2 }]}>
      <View style={st.row}>{p.cats.map((c) => <Text key={c} style={[st.tag, { backgroundColor: tagColor[c] }]}>{tagText[c]}</Text>)}
        <Text style={[st.muted, { marginLeft: 'auto' }]}>{p.kind === 'prop' ? 'Player prop' : 'Game'}</Text></View>
      <Text style={st.h3}>{p.title}</Text>
      <Text style={st.muted}>{p.sub}{p.kickoff ? `  ·  ${when(p.kickoff)}` : ''}</Text>
      <View style={[st.row, { marginTop: 10, gap: 8 }]}>
        <Stat st={st} label="Win chance" value={pct(p.fair)} />
        <Stat st={st} label="Kalshi price" value={cents(p.cost)} />
        <Stat st={st} label="Edge" value={`+${p.edge.toFixed(1)}`} color={C.value} />
        <Stat st={st} label="Pays" value={`${p.payout.toFixed(2)}x`} />
      </View>
      <Text style={[st.body, { marginTop: 8 }]}>Don't pay more than <Text style={st.bold}>{cents(p.maxPrice)}</Text>. A limit order there pays a lower fee than buying at the ask.</Text>
      {p.size && <Text style={st.body}>Suggested size: <Text style={st.bold}>{p.size.contracts} contracts (${p.size.stake.toFixed(2)})</Text>, {p.size.pct}% of bankroll.</Text>}
      <Text style={[st.muted, { marginTop: 4 }]}>
        {[p.smAgrees && 'SharpMush agrees', p.moneyAgrees && 'Kalshi big money agrees', p.moneyAgainst && 'Kalshi big money is on the other side',
          p.spread != null && p.spread * 100 > 4 && `Wide spread (${Math.round(p.spread * 100)}¢)`,
          p.model && `Model: ${p.model.source}, ${p.model.games} games this season`].filter(Boolean).join('  ·  ')}
      </Text>
      <View style={[st.row, { marginTop: 10, gap: 8 }]}>
        <Btn st={st} label="Open in Kalshi" onPress={() => Linking.openURL(kalshiUrl(p.eventTicker))} />
        <Btn st={st} primary label="I placed this" onPress={() => onBet({ ...p, price: p.cost, contracts: p.size?.contracts || 1 })} />
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ Games
function Games({ e, st, C, onChange }) {
  if (!e.games.length) return <Empty st={st} text={e.updated ? 'No open NFL game markets on Kalshi right now.' : 'Loading games…'} />;
  return <View>{e.games.map((g) => <GameCard key={g.key} g={g} e={e} st={st} C={C} onChange={onChange} />)}</View>;
}

function GameCard({ g, e, st, C, onChange }) {
  const [smSide, setSmSide] = useState(g.sharpmush?.side || 'a');
  const [smPct, setSmPct] = useState(g.sharpmush ? String(g.sharpmush.pct) : '');
  const [fair, setFair] = useState(g.fairSrc === 'your number' ? String(+(g.fairA * 100).toFixed(1)) : '');
  const share = g.money.total > 0 ? g.a.back / g.money.total : 0.5;
  const vs = g.valueSide ? g[g.valueSide] : null;
  return (
    <View style={[st.card, g.status === 'gold' && { borderColor: C.gold, borderWidth: 2, backgroundColor: C.goldWash }, g.status === 'split' && { borderLeftColor: C.split, borderLeftWidth: 5 }]}>
      <Text style={st.h3}>{g.a.team} vs {g.b.team}</Text>
      <Text style={st.muted}>{when(g.kickoff)}  ·  {g.basis}</Text>
      {g.status === 'gold' && <Text style={[st.tag, { backgroundColor: C.gold, alignSelf: 'flex-start', marginTop: 8 }]}>Signals agree: {vs.team}</Text>}
      {g.status === 'split' && <Text style={[st.body, { color: C.split, marginTop: 6, fontWeight: '700' }]}>Signals disagree</Text>}

      <View style={[st.row, { marginTop: 10 }]}>
        <Text style={[st.body, { flex: 1 }]}>{g.a.team}</Text><Text style={st.num}>{cents(g.a.cost)}</Text><Text style={[st.num, { width: 64 }]}>{pct(g.a.fair, 1)}</Text>
      </View>
      <View style={st.row}>
        <Text style={[st.body, { flex: 1 }]}>{g.b.team}</Text><Text style={st.num}>{cents(g.b.cost)}</Text><Text style={[st.num, { width: 64 }]}>{pct(g.b.fair, 1)}</Text>
      </View>
      <Text style={[st.muted, { textAlign: 'right' }]}>Kalshi price  ·  fair ({g.fairSrc || 'none yet'})</Text>

      <Indicator st={st} color={C.best} title="Best bettors (SharpMush)"
        text={g.sharpmush ? `${g.sharpmush.pct}% on ${shortTeam(g[g.sharpmush.side].team)}, entered ${Math.round(g.sharpmush.ageH)} h ago${g.sharpmush.ok ? '' : g.sharpmush.ageH >= e.settings.sharpMushStaleHours ? ' (stale: update it)' : ' (below your bar)'}` : 'Not entered. Look it up in Juice Reel.'} />
      <Indicator st={st} color={C.value} title="Value"
        text={g.bestEdge == null ? 'Needs a fair price (your number or an Odds API key)' : g.valueSide ? `+${g.bestEdge.toFixed(1)} pts on ${shortTeam(vs.team)} after fees. Don't pay over ${cents(g.candidate?.maxPrice)}.` : 'No value on either side'} />
      <Indicator st={st} color={C.money} title="Kalshi big money"
        text={g.money.total > 0 ? `${usd(Math.max(g.a.back, g.b.back))} on ${shortTeam(g[g.money.side].team)}, score ${g.money.score}, ${g.bigTrades} big trades` : 'No big trades in the last 24 h'} />
      <View style={st.bar}><View style={{ flex: share, backgroundColor: C.money }} /><View style={{ flex: 1 - share, backgroundColor: C.line }} /></View>

      <Text style={[st.label, { marginTop: 12 }]}>SharpMush from Juice Reel</Text>
      <View style={[st.row, { gap: 6 }]}>
        {['a', 'b'].map((k) => <Chip key={k} st={st} on={smSide === k} label={shortTeam(g[k].team)} onPress={() => setSmSide(k)} />)}
        <TextInput style={[st.input, { width: 70 }]} value={smPct} onChangeText={setSmPct} keyboardType="decimal-pad" placeholder="%" placeholderTextColor={C.muted} />
        <Btn st={st} label="Save" onPress={async () => { await e.setSharpMush(g.key, smSide, smPct === '' ? null : Math.abs(+smPct)); await syncScanner(e); onChange(); }} />
      </View>
      <Text style={[st.label, { marginTop: 10 }]}>Your fair win % for {shortTeam(g.a.team)} (optional)</Text>
      <View style={[st.row, { gap: 6 }]}>
        <TextInput style={[st.input, { width: 90 }]} value={fair} onChangeText={setFair} keyboardType="decimal-pad" placeholder={g.fairSrc ? pct(g.fairA, 1) : '%'} placeholderTextColor={C.muted} />
        <Btn st={st} label="Save" onPress={async () => { const v = parseFloat(fair); await e.setMyFair(g.key, v > 0 && v < 100 ? v / 100 : null); await syncScanner(e); onChange(); }} />
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ Props
function Props({ e, st, C, onBet }) {
  const [q, setQ] = useState(''); const [filter, setFilter] = useState('value'); const [open, setOpen] = useState(null);
  const rows = e.props.filter((r) => (filter === 'all' || (filter === 'value' ? ['gold', 'value'].includes(r.status) : r.status === 'gold'))
    && (!q || `${r.player} ${r.team} ${r.statLabel}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <View>
      <TextInput style={st.input} value={q} onChangeText={setQ} placeholder="Search player, team or stat" placeholderTextColor={C.muted} />
      <View style={[st.row, { gap: 6, marginVertical: 10 }]}>
        {[['value', 'Has value'], ['gold', 'Signals agree'], ['all', 'All']].map(([k, l]) => <Chip key={k} st={st} on={filter === k} label={l} onPress={() => setFilter(k)} />)}
      </View>
      <Text style={[st.muted, { marginBottom: 8 }]}>{e.props.length} props on Kalshi. Updated {ago(e.propsUpdated)}. Kalshi only lists props for some games.</Text>
      {rows.length === 0 && <Empty st={st} text="No props match." />}
      {rows.slice(0, 150).map((r) => {
        const isOpen = open === r.ticker, m = r.model;
        return (
          <Pressable key={r.ticker} onPress={() => setOpen(isOpen ? null : r.ticker)} style={[st.card, { paddingVertical: 10 }, r.status === 'gold' && { borderColor: C.gold, borderWidth: 2 }]}>
            <View style={st.row}>
              <View style={{ flex: 1 }}>
                <Text style={st.bodyBold}>{r.label}</Text>
                <Text style={st.muted}>{r.team ? `${r.team} ${r.pos || ''}  ·  ` : ''}{r.gameTitle}{r.injury ? `  ·  ` : ''}{r.injury ? <Text style={{ color: C.neg, fontWeight: '700' }}>{r.injury}</Text> : null}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={st.num}>Yes {cents(r.yes)}  No {cents(r.no)}</Text>
                <Text style={[st.muted, { color: r.valueSide ? C.value : C.muted }]}>{r.fair == null ? (r.matched ? 'no stats' : 'player not found') : r.valueSide ? `${r.valueSide.toUpperCase()} +${r.bestEdge.toFixed(1)}` : `fair ${pct(r.fair)}`}</Text>
              </View>
            </View>
            {isOpen && (
              <View style={{ marginTop: 8 }}>
                {m && <Text style={st.body}>Fair chance of {r.line}+: {pct(r.fair, 1)}. Based on {m.source} (average {m.mean}, typical swing ±{m.sd}), {m.games} games this season{m.gamesLast ? ` and ${m.gamesLast} from last season` : ''}. Hit this line in {pct(m.hitRate)} of weighted games.{m.script ? ` Game script adjustment ${m.script > 0 ? '+' : ''}${m.script}%.` : ''}{m.role?.flag ? ` Snap share is trending ${m.role.flag} (${pct(m.role.before)} → ${pct(m.role.recent)}), so older games count less.` : ''}</Text>}
                <Text style={st.body}>Kalshi big money: {r.money.total > 0 ? `${usd(r.money.total)}, leaning ${r.money.side?.toUpperCase()} (score ${r.money.score})` : 'none'}{r.thin ? '. Thin market, so read little into it.' : ''}</Text>
                {r.candidate && <View style={[st.row, { gap: 8, marginTop: 8 }]}>
                  <Btn st={st} label="Open in Kalshi" onPress={() => Linking.openURL(kalshiUrl(r.candidate.eventTicker))} />
                  <Btn st={st} primary label="I placed this" onPress={() => onBet({ ...r.candidate, price: r.candidate.cost, contracts: r.candidate.size?.contracts || 1 })} />
                </View>}
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------ Bets + record
function Bets({ e, st, C, sum, onChange }) {
  const [view, setView] = useState('bets');
  const rec = e.record();
  return (
    <View>
      <Segmented st={st} value={view} onChange={setView} options={[['bets', 'My bets'], ['record', 'Signal record']]} />
      {view === 'bets' ? (
        <View style={{ marginTop: 12 }}>
          <View style={[st.row, { gap: 8 }]}>
            <Stat st={st} big label="Profit" value={`${sum.pnl >= 0 ? '+' : '-'}$${Math.abs(sum.pnl).toFixed(2)}`} color={sum.pnl >= 0 ? C.value : C.neg} />
            <Stat st={st} big label="ROI" value={sum.roi == null ? '—' : `${sum.roi.toFixed(1)}%`} />
            <Stat st={st} big label="Avg CLV" value={sum.clv == null ? '—' : `${sum.clv >= 0 ? '+' : ''}${sum.clv.toFixed(1)}¢`} color={sum.clv > 0 ? C.value : undefined} />
          </View>
          <Text style={[st.muted, { marginVertical: 8 }]}>CLV compares your price with Kalshi's last price before kickoff. It's the best early sign of skill: profit swings a lot over small samples, beating the close doesn't. {sum.nClv ? `You beat the close on ${sum.beatClose.toFixed(0)}% of ${sum.nClv} bets.` : ''}</Text>
          {e.bets.length === 0 && <Empty st={st} text={'Tap "I placed this" on a pick after you bet it in Kalshi. The app then tracks the closing price and the result.'} />}
          {e.bets.map((b) => {
            const clv = b.closePrice != null ? 100 * (b.closePrice - b.price) : null;
            return (
              <View key={b.id} style={st.card}>
                <View style={st.row}><Text style={[st.bodyBold, { flex: 1 }]}>{b.title}</Text>
                  <Text style={[st.tag, { backgroundColor: b.status === 'won' ? C.value : b.status === 'lost' ? C.neg : C.muted }]}>{b.status}</Text></View>
                <Text style={st.muted}>{b.contracts} × {b.side.toUpperCase()} at {cents(b.price)} + ${b.fee.toFixed(2)} fee  ·  {when(b.time)}</Text>
                <Text style={st.body}>{clv == null ? 'Close: waiting' : `Close ${cents(b.closePrice)} (${clv >= 0 ? '+' : ''}${clv.toFixed(0)}¢ CLV)`}{b.pnl != null ? `  ·  P/L ${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)}` : ''}</Text>
                {b.status === 'open' && <View style={[st.row, { gap: 8, marginTop: 6 }]}>
                  <Btn st={st} label="Remove" onPress={() => Alert.alert('Remove this bet?', 'It will no longer be tracked.', [{ text: 'Cancel' }, { text: 'Remove', style: 'destructive', onPress: async () => { await e.deleteBet(b.id); onChange(); } }])} />
                  <Btn st={st} label="Mark void" onPress={async () => { await e.voidBet(b.id); onChange(); }} />
                </View>}
              </View>
            );
          })}
        </View>
      ) : (
        <View style={{ marginTop: 12 }}>
          <Text style={[st.muted, { marginBottom: 8 }]}>Every pick the app makes is paper-traded at 1 contract, whether you bet it or not. Use this to decide which categories to trust. Wait for a few hundred picks before reading much into it.</Text>
          {['safe', 'upside', 'gold'].map((k) => {
            const r = rec[k];
            return (
              <View key={k} style={st.card}>
                <Text style={st.h3}>{CAT[k].label}</Text>
                <View style={[st.row, { gap: 8, marginTop: 6 }]}>
                  <Stat st={st} label="Picks" value={String(r.signals)} />
                  <Stat st={st} label="Record" value={r.settled ? `${r.wins}-${r.settled - r.wins}` : '—'} />
                  <Stat st={st} label="ROI" value={r.roi == null ? '—' : `${r.roi.toFixed(1)}%`} />
                  <Stat st={st} label="Avg CLV" value={r.clv == null ? '—' : `${r.clv >= 0 ? '+' : ''}${r.clv.toFixed(1)}¢`} />
                </View>
                {r.clvSe != null && <Text style={st.muted}>CLV margin of error ±{(2 * r.clvSe).toFixed(1)}¢ over {r.nClv} picks{Math.abs(r.clv) > 2 * r.clvSe ? ' (meaningful)' : ' (could still be luck)'}.</Text>}
                {r.calibration.length > 0 && <View style={{ marginTop: 6 }}>
                  <Text style={st.label}>Is the model honest? When it says X%, how often does it win?</Text>
                  {r.calibration.map((b) => <Text key={b.range} style={st.body}>{b.range}: said {b.said.toFixed(0)}%, won {b.won.toFixed(0)}% ({b.n})</Text>)}
                </View>}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ------------------------------------------------------------------ Settings
const FIELDS = [
  ['Your money', [['bankroll', 'Bankroll ($)'], ['kellyFraction', 'Kelly fraction (0.25 = quarter)'], ['maxBetPct', 'Max per bet (% of bankroll)'],
    ['maxGameExposurePct', 'Max on one game (%)'], ['dailyLossLimit', 'Daily loss limit ($)'], ['maxBetsPerDay', 'Max bets per day']]],
  ['Likely wins', [['safeMinProb', 'Minimum win chance (%)'], ['safeMinEdge', 'Minimum edge (pts)'], ['safeMinGames', 'Minimum games of player history']]],
  ['Upside', [['upsideMaxPrice', 'Max Kalshi price (¢)'], ['upsideMinProb', 'Minimum win chance (%)'], ['upsideMinEdge', 'Minimum edge (pts)']]],
  ['Games', [['minSharpMush', 'SharpMush needed (%)'], ['sharpMushStaleHours', 'SharpMush goes stale after (h)'], ['gameMinEdge', 'Edge needed (pts)'],
    ['gameBigTrade', 'Big trade, at least ($)'], ['gameMinMoney', 'Money score needed (0–100)']]],
  ['Props', [['propMinEdge', 'Edge needed (pts)'], ['propBigTrade', 'Big trade, at least ($)'], ['propMinMoney', 'Money score needed (0–100)'],
    ['suspectEdge', 'Flag edges above (pts) for a news check']]],
  ['Costs', [['feeRate', 'Kalshi taker fee rate'], ['makerFeeRate', 'Kalshi maker fee rate'], ['maxSpreadCents', 'Widest spread allowed (¢)']]],
  ['Scanning', [['scanMinutes', 'Scan every (minutes)'], ['oddsMinutes', 'Pull Odds API every (minutes)']]],
];
function Settings({ e, st, C, onSaved }) {
  const [vals, setVals] = useState(() => Object.fromEntries(Object.entries(e.settings).map(([k, v]) => [k, String(v)])));
  const [demo, setDemo] = useState(!!e.settings.demo);
  const [notify, setNotify] = useState({ notifySafe: !!e.settings.notifySafe, notifyUpside: !!e.settings.notifyUpside, notifyGold: !!e.settings.notifyGold });
  const [scanStatus, setScanStatus] = useState(remoteOn(e.settings) ? `Connected. ${e.remoteDevices ?? '?'} device(s) get alerts.` : '');
  const connect = async () => {
    const url = (vals.scannerUrl || '').trim(), key = (vals.scannerKey || '').trim();
    if (!/^https:\/\//.test(url) || key.length < 16) return Alert.alert('Check the scanner', 'Use the https:// address of your scanner and its key (16+ characters).');
    await e.setSettings({ scannerUrl: url, scannerKey: key });
    try { setScanStatus('Connecting…'); await enableAlerts(e); setScanStatus('Connected. Push alerts are on for this phone.'); onSaved(false); }
    catch (err) { setScanStatus(err.message); }
  };
  const disconnect = async () => { await e.setSettings({ scannerUrl: '', scannerKey: '' }); e.remoteRecord = null; setVals({ ...vals, scannerUrl: '', scannerKey: '' }); setScanStatus('Disconnected. The app scans on its own while open.'); onSaved(true); };
  const save = async () => {
    const patch = {};
    for (const [, fields] of FIELDS) for (const [k, label] of fields) {
      const v = parseFloat(vals[k]);
      if (isNaN(v) || v < 0) return Alert.alert('Check this setting', `${label} needs a number of 0 or more.`);
      patch[k] = v;
    }
    if (patch.scanMinutes < 2) return Alert.alert('Check this setting', 'Scan at most every 2 minutes, so Kalshi and Sleeper keep answering.');
    patch.oddsApiKey = (vals.oddsApiKey || '').trim(); patch.demo = demo; Object.assign(patch, notify);
    const demoChanged = demo !== !!e.settings.demo;
    await e.setSettings(patch); await syncScanner(e); onSaved(demoChanged);
    Alert.alert('Saved', 'Settings saved. Refreshing now.');
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'position' : undefined}>
      <View style={[st.card, st.row]}>
        <View style={{ flex: 1 }}><Text style={st.bodyBold}>Demo data</Text><Text style={st.muted}>Made-up markets to try the app. Bets you log in demo mode land in the same list as real ones, so remove them before tracking real bets.</Text></View>
        <Switch value={demo} onValueChange={setDemo} />
      </View>
      <View style={st.card}>
        <Text style={st.h3}>Live scanner (24/7 alerts)</Text>
        <Text style={st.muted}>iPhone apps can't run every 10 minutes in the background. Your scanner server can: it scans around the clock and sends a push alert when a new pick appears. Setup is in the README.</Text>
        <TextInput style={[st.input, { marginTop: 8 }]} value={vals.scannerUrl} onChangeText={(t) => setVals({ ...vals, scannerUrl: t })} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://your-scanner.example.com" placeholderTextColor={C.muted} />
        <TextInput style={[st.input, { marginTop: 6 }]} value={vals.scannerKey} onChangeText={(t) => setVals({ ...vals, scannerKey: t })} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Scanner key" placeholderTextColor={C.muted} />
        <View style={[st.row, { gap: 8, marginTop: 8 }]}>
          <Btn st={st} primary label="Connect and turn on alerts" onPress={connect} />
          {remoteOn(e.settings) && <Btn st={st} label="Disconnect" onPress={disconnect} />}
        </View>
        {!!scanStatus && <Text style={[st.body, { marginTop: 6 }]}>{scanStatus}</Text>}
        <Text style={[st.label, { marginTop: 10 }]}>Alert me about</Text>
        {[['notifySafe', 'Likely wins'], ['notifyUpside', 'Upside'], ['notifyGold', 'Signals agree']].map(([k, l]) => (
          <View key={k} style={[st.row, { marginTop: 4 }]}><Text style={[st.body, { flex: 1 }]}>{l}</Text>
            <Switch value={notify[k]} onValueChange={(v) => setNotify({ ...notify, [k]: v })} /></View>
        ))}
      </View>
      <View style={st.card}>
        <Text style={st.bodyBold}>The Odds API key (optional)</Text>
        <Text style={st.muted}>Gives game winners a fair price from Pinnacle automatically. Free key at the-odds-api.com. The free plan's 500 credits a month cover one pull every 90 minutes.</Text>
        <TextInput style={[st.input, { marginTop: 6 }]} value={vals.oddsApiKey} onChangeText={(t) => setVals({ ...vals, oddsApiKey: t })} autoCapitalize="none" autoCorrect={false} placeholder="Paste key" placeholderTextColor={C.muted} />
      </View>
      {FIELDS.map(([group, fields]) => (
        <View key={group} style={st.card}>
          <Text style={st.h3}>{group}</Text>
          {fields.map(([k, label]) => (
            <View key={k} style={[st.row, { marginTop: 8 }]}>
              <Text style={[st.body, { flex: 1 }]}>{label}</Text>
              <TextInput style={[st.input, { width: 90, textAlign: 'right' }]} value={vals[k]} onChangeText={(t) => setVals({ ...vals, [k]: t })} keyboardType="decimal-pad" />
            </View>
          ))}
        </View>
      ))}
      <Btn st={st} primary label="Save settings" onPress={save} />
      <Text style={[st.muted, { marginTop: 14 }]}>Sharp Side reads public data from Kalshi, Sleeper and (optionally) The Odds API. It never connects to your Kalshi account or places bets. Picks are estimates, not guarantees. Only bet what you can afford to lose.</Text>
    </KeyboardAvoidingView>
  );
}

// ------------------------------------------------------------------ bet modal
function BetModal({ draft, st, C, onClose, onSave }) {
  const [price, setPrice] = useState(''); const [n, setN] = useState('');
  useEffect(() => { if (draft) { setPrice(String(Math.round(draft.price * 100))); setN(String(draft.contracts)); } }, [draft]);
  if (!draft) return null;
  const save = () => {
    const p = parseFloat(price) / 100, c = parseInt(n, 10);
    if (!(p > 0 && p < 1) || !(c > 0)) return Alert.alert('Check the numbers', 'Price must be 1–99¢ and contracts at least 1.');
    onSave({ ...draft, price: p, contracts: c });
  };
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.modalWrap}>
        <View style={st.modal}>
          <Text style={st.h3}>Log this bet</Text>
          <Text style={st.muted}>{draft.title}</Text>
          <Text style={[st.label, { marginTop: 12 }]}>Price you got (¢)</Text>
          <TextInput style={st.input} value={price} onChangeText={setPrice} keyboardType="number-pad" />
          <Text style={[st.label, { marginTop: 10 }]}>Contracts</Text>
          <TextInput style={st.input} value={n} onChangeText={setN} keyboardType="number-pad" />
          <View style={[st.row, { gap: 8, marginTop: 16 }]}>
            <Btn st={st} label="Cancel" onPress={onClose} />
            <Btn st={st} primary label="Save bet" onPress={save} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ------------------------------------------------------------------ small parts
const Stat = ({ st, label, value, color, big }) => (
  <View style={st.stat}><Text style={[big ? st.statBig : st.statVal, color && { color }]}>{value}</Text><Text style={st.statLabel}>{label}</Text></View>);
const Indicator = ({ st, color, title, text }) => (
  <View style={{ marginTop: 10 }}><Text style={[st.bodyBold, { color }]}>{title}</Text><Text style={st.body}>{text}</Text></View>);
const Btn = ({ st, label, onPress, primary }) => (
  <Pressable onPress={onPress} style={({ pressed }) => [st.btn, primary && st.btnPrimary, pressed && { opacity: 0.7 }]} accessibilityRole="button">
    <Text style={[st.btnText, primary && st.btnPrimaryText]}>{label}</Text></Pressable>);
const Chip = ({ st, label, on, onPress }) => (
  <Pressable onPress={onPress} style={[st.chip, on && st.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
    <Text style={[st.chipText, on && st.chipTextOn]}>{label}</Text></Pressable>);
const Segmented = ({ st, value, onChange, options }) => (
  <View style={st.seg}>{options.map(([k, l]) => (
    <Pressable key={k} onPress={() => onChange(k)} style={[st.segBtn, value === k && st.segOn]} accessibilityRole="tab" accessibilityState={{ selected: value === k }}>
      <Text style={[st.segText, value === k && st.segTextOn]} numberOfLines={1}>{l}</Text></Pressable>))}</View>);
const Empty = ({ st, text }) => <View style={st.empty}><Text style={[st.muted, { textAlign: 'center' }]}>{text}</Text></View>;

function makeStyles(C) {
  return StyleSheet.create({
    fill: { flex: 1, backgroundColor: C.bg }, center: { alignItems: 'center', justifyContent: 'center' },
    header: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 },
    brand: { fontSize: 34, fontWeight: '800', color: C.ink, letterSpacing: -0.5 },
    h2: { fontSize: 20, fontWeight: '800', color: C.ink, marginBottom: 4 },
    h3: { fontSize: 18, fontWeight: '700', color: C.ink, marginTop: 6 },
    body: { fontSize: 15, color: C.ink, lineHeight: 21 }, bodyBold: { fontSize: 15, color: C.ink, fontWeight: '700' },
    bold: { fontWeight: '700' }, muted: { fontSize: 13, color: C.muted, lineHeight: 18 },
    label: { fontSize: 13, color: C.muted, marginBottom: 4 },
    num: { fontSize: 15, color: C.ink, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right', minWidth: 48 },
    card: { backgroundColor: C.card, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.line },
    row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
    tag: { color: '#fff', fontWeight: '700', fontSize: 12, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden', marginRight: 6 },
    stat: { flexGrow: 1, flexBasis: 70, backgroundColor: C.chip, borderRadius: 10, padding: 8 },
    statVal: { fontSize: 18, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
    statBig: { fontSize: 22, fontWeight: '800', color: C.ink, fontVariant: ['tabular-nums'] },
    statLabel: { fontSize: 12, color: C.muted },
    bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 6 },
    input: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, color: C.ink, backgroundColor: C.bg },
    btn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.card },
    btnPrimary: { backgroundColor: C.ink, borderColor: C.ink }, btnText: { color: C.ink, fontWeight: '700', fontSize: 15 }, btnPrimaryText: { color: C.card },
    chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: C.chip, borderWidth: 1, borderColor: C.line },
    chipOn: { backgroundColor: C.ink, borderColor: C.ink }, chipText: { color: C.ink, fontWeight: '600' }, chipTextOn: { color: C.card },
    seg: { flexDirection: 'row', backgroundColor: C.chip, borderRadius: 12, padding: 3 },
    segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' }, segOn: { backgroundColor: C.card },
    segText: { color: C.muted, fontWeight: '600', fontSize: 13 }, segTextOn: { color: C.ink },
    tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card, paddingTop: 8 },
    tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 4 }, tabText: { color: C.muted, fontWeight: '600', fontSize: 13 }, tabOn: { color: C.ink, fontWeight: '800' },
    errBox: { backgroundColor: C.neg, marginHorizontal: 14, borderRadius: 10, padding: 10, marginBottom: 6 }, errText: { color: '#fff', fontSize: 13 },
    warnBox: { backgroundColor: C.split, marginHorizontal: 14, borderRadius: 10, padding: 10, marginBottom: 6 }, warnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
    empty: { borderWidth: 1, borderStyle: 'dashed', borderColor: C.line, borderRadius: 14, padding: 22 },
    modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
    modal: { backgroundColor: C.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, paddingBottom: 36 },
  });
}
