// Sharp Side: constants and defaults. Everything tunable lives in DEFAULT_SETTINGS.
export const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
export const SLEEPER = 'https://api.sleeper.app/v1';
export const ODDS = 'https://api.the-odds-api.com/v4';

export const GAME_SERIES = 'KXNFLGAME';
// Per-game player prop series on Kalshi. Add tickers here as Kalshi lists new ones.
export const PROP_SERIES = {
  KXNFLRECYDS: 'rec_yd', KXNFLRSHYDS: 'rush_yd', KXNFLPASSYDS: 'pass_yd', KXNFLREC: 'rec',
  KXNFLTD: 'td', KXNFLRSHATT: 'rush_att', KXNFLPASSATT: 'pass_att', KXNFLPASSCOMP: 'pass_cmp',
};

export const STATS = {
  rec_yd:   { label: 'receiving yards', keys: ['rec_yd'], kind: 'normal', max: 350, sdFloor: 12 },
  rush_yd:  { label: 'rushing yards', keys: ['rush_yd'], kind: 'normal', max: 300, sdFloor: 12 },
  pass_yd:  { label: 'passing yards', keys: ['pass_yd'], kind: 'normal', max: 550, sdFloor: 30 },
  rec:      { label: 'receptions', keys: ['rec'], kind: 'poisson', max: 20 },
  td:       { label: 'touchdowns', keys: ['rush_td', 'rec_td'], kind: 'poisson', max: 5 },
  pass_td:  { label: 'passing TDs', keys: ['pass_td'], kind: 'poisson', max: 7 },
  rush_att: { label: 'rush attempts', keys: ['rush_att'], kind: 'normal', max: 45, sdFloor: 3 },
  pass_att: { label: 'pass attempts', keys: ['pass_att'], kind: 'normal', max: 70, sdFloor: 4 },
  pass_cmp: { label: 'completions', keys: ['pass_cmp'], kind: 'normal', max: 50, sdFloor: 3 },
};
export const TITLE_STATS = [
  ['passing touchdown', 'pass_td'], ['passing yard', 'pass_yd'], ['rushing yard', 'rush_yd'],
  ['receiving yard', 'rec_yd'], ['reception', 'rec'], ['rushing attempt', 'rush_att'], ['rush attempt', 'rush_att'],
  ['passing attempt', 'pass_att'], ['pass attempt', 'pass_att'], ['completion', 'pass_cmp'], ['touchdown', 'td'],
];
// Favorites run more, underdogs throw more. Applied only when there is no Sleeper projection.
export const SCRIPT = { rush_yd: 0.15, rush_att: 0.15, pass_yd: -0.1, pass_att: -0.1, pass_cmp: -0.1, rec_yd: -0.05, rec: -0.05 };
export const OUT_STATUSES = ['out', 'doubtful', 'ir', 'pup', 'sus', 'suspended', 'nfi', 'cov'];
export const STATS_WANTED = ['rec_yd', 'rush_yd', 'pass_yd', 'rec', 'rush_td', 'rec_td', 'pass_td', 'rush_att',
  'pass_att', 'pass_cmp', 'gp', 'off_snp', 'tm_off_snp', 'rec_tgt'];

export const DEFAULT_SETTINGS = {
  // money
  bankroll: 1000, kellyFraction: 0.25, maxBetPct: 2, maxGameExposurePct: 5,
  dailyLossLimit: 100, maxBetsPerDay: 8,
  // games
  minSharpMush: 10, gameMinEdge: 2, gameBigTrade: 1000, gameMinMoney: 60, sharpMushStaleHours: 12,
  // props (higher bar: the prop model is simpler than a sharp sportsbook)
  propMinEdge: 5, propBigTrade: 250, propMinMoney: 60,
  // "Likely wins": high chance to win, still priced in your favor
  safeMinProb: 70, safeMinEdge: 2.5, safeMinGames: 4,
  // "Upside": pays about 2x or more, bigger edge, and at least one other signal agrees
  upsideMaxPrice: 45, upsideMinProb: 25, upsideMinEdge: 6,
  // An edge this big usually means news the model doesn't know (injury, role change), not free money.
  suspectEdge: 15,
  // costs and data
  feeRate: 0.07, makerFeeRate: 0.0175, maxSpreadCents: 4, lookbackHours: 24,
  oddsApiKey: '', demo: false,
  // live scanning
  scanMinutes: 10,
  // The Odds API free tier is 500 credits a month; one pull every 90 min is ~480.
  oddsMinutes: 90,
  notifySafe: true, notifyUpside: true, notifyGold: true,
  scannerUrl: '', scannerKey: '',
};

export const NFL = {
  'Arizona Cardinals': 'ARI|Arizona|Cardinals', 'Atlanta Falcons': 'ATL|Atlanta|Falcons',
  'Baltimore Ravens': 'BAL|Baltimore|Ravens', 'Buffalo Bills': 'BUF|Buffalo|Bills',
  'Carolina Panthers': 'CAR|Carolina|Panthers', 'Chicago Bears': 'CHI|Chicago|Bears',
  'Cincinnati Bengals': 'CIN|Cincinnati|Bengals', 'Cleveland Browns': 'CLE|Cleveland|Browns',
  'Dallas Cowboys': 'DAL|Dallas|Cowboys', 'Denver Broncos': 'DEN|Denver|Broncos',
  'Detroit Lions': 'DET|Detroit|Lions', 'Green Bay Packers': 'GB|GNB|Green Bay|Packers',
  'Houston Texans': 'HOU|Houston|Texans', 'Indianapolis Colts': 'IND|Indianapolis|Colts',
  'Jacksonville Jaguars': 'JAX|JAC|Jacksonville|Jaguars', 'Kansas City Chiefs': 'KC|KAN|Kansas City|Chiefs',
  'Las Vegas Raiders': 'LV|LVR|Las Vegas|Raiders', 'Los Angeles Chargers': 'LAC|Los Angeles C|LA Chargers|Chargers',
  'Los Angeles Rams': 'LAR|LA|Los Angeles R|LA Rams|Rams', 'Miami Dolphins': 'MIA|Miami|Dolphins',
  'Minnesota Vikings': 'MIN|Minnesota|Vikings', 'New England Patriots': 'NE|NWE|New England|Patriots',
  'New Orleans Saints': 'NO|NOR|New Orleans|Saints', 'New York Giants': 'NYG|New York G|NY Giants|Giants',
  'New York Jets': 'NYJ|New York J|NY Jets|Jets', 'Philadelphia Eagles': 'PHI|Philadelphia|Eagles',
  'Pittsburgh Steelers': 'PIT|Pittsburgh|Steelers', 'San Francisco 49ers': 'SF|SFO|San Francisco|49ers|Niners',
  'Seattle Seahawks': 'SEA|Seattle|Seahawks', 'Tampa Bay Buccaneers': 'TB|TAM|Tampa Bay|Buccaneers|Bucs',
  'Tennessee Titans': 'TEN|Tennessee|Titans', 'Washington Commanders': 'WAS|WSH|Washington|Commanders',
};
