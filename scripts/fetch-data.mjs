#!/usr/bin/env node
/**
 * 練功房資料抓取腳本
 *
 * 標的組成（每次執行動態決定）：
 *   - 期指：NQ、TXF（固定）
 *   - 加密貨幣：Binance USDT 現貨「近 30 天成交額」前 20 名（＋固定保底 BTC/ETH/SOL/BNB/XRP/DOGE）
 *   - 美股：候選池內「近 30 天成交量(股數)」前 20 名（＋固定保底既有 11 檔）
 *   - 台股：候選池內「近 30 天成交量(股數)」前 20 名（＋固定保底既有 10 檔）
 *
 * 資料來源：
 *   - 加密貨幣：Binance REST（1d 自 2020；1h 僅 BTC/ETH/SOL，BTC 全量、其餘近 720 天）
 *   - 美股 / 台股 / NQ：Yahoo Finance（1d 自 2020；NQ 另有 1h 近 720 天）
 *   - TXF：FinMind（1d TX 連續近月）+ Yahoo ^TWII（1h proxy）
 *
 * 每次執行結束會依實際存在的檔案產出 data/symbols.json 清單（給前端動態載入）。
 *
 * 用法：
 *   node scripts/fetch-data.mjs                 # 排名 + 全部抓取
 *   node scripts/fetch-data.mjs BTC 2330TW      # 只抓指定 key（跳過排名，僅限上次清單內）
 *   node scripts/fetch-data.mjs --manifest-only # 只重建 symbols.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const REGISTRY_CACHE = path.join(DATA_DIR, 'registry-cache.json');

const START_DATE = '2020-01-01';
const START_TS = new Date(`${START_DATE}T00:00:00Z`).getTime();
const NOW_TS = Date.now();
const TWD_USD = 31;   // 概略匯率：台幣計價標的換算 USD 用
const TOP_N = 20;     // 每類別取成交量前 N 名

const sleep = ms => new Promise(r => setTimeout(r, ms));
const YH = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
};

// ============================================================
// 固定標的（期指）＋各類別保底（舊清單，確保既有交易紀錄的標的不消失）
// ============================================================
const FUTURES = [
  { key: 'NQ',  name: 'NQ 那斯達克100期貨', category: 'futures', pointValue: 20, sizeUnit: '口', sizeDecimals: 2,
    fetch: { type: 'yahoo', ticker: 'NQ=F', tfs: ['1d', '1h'] } },
  { key: 'TXF', name: 'TXF 台指期', category: 'futures', pointValue: 200 / TWD_USD, sizeUnit: '口', sizeDecimals: 2,
    fetch: { type: 'txf', tfs: ['1d', '1h'] } },
];

const CRYPTO_ALWAYS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
const CRYPTO_1H = { BTC: 'full', ETH: '720d', SOL: '720d' };  // 其餘只抓 1d
// 排名時排除的 base asset（穩定幣 / 包裝資產 / 法幣）
const CRYPTO_EXCLUDE = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDE', 'USD1', 'XUSD', 'BFUSD',
  'RLUSD', 'PYUSD', 'GUSD', 'USTC', 'USDD',
  'EUR', 'EURI', 'AEUR', 'GBP', 'TRY', 'BRL', 'JPY', 'ARS', 'COP', 'MXN',
  'WBTC', 'WBETH', 'BNSOL', 'CBBTC', 'STETH', 'WSTETH', 'SOLV',
]);
const CRYPTO_NAMES = {
  BTC: '比特幣', ETH: '以太坊', BNB: '幣安幣', SOL: 'Solana', XRP: '瑞波幣', DOGE: '狗狗幣',
  ADA: 'Cardano', TRX: '波場', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: '波卡',
  POL: 'Polygon', MATIC: 'Polygon', LTC: '萊特幣', SHIB: '柴犬幣', PEPE: '佩佩蛙',
  BCH: '比特幣現金', NEAR: 'NEAR Protocol', SUI: 'Sui', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism',
  TON: 'Toncoin', WIF: 'dogwifhat', BONK: 'Bonk', FLOKI: 'Floki', FIL: 'Filecoin', UNI: 'Uniswap',
  ATOM: 'Cosmos', ETC: '以太經典', XLM: '恆星幣', HBAR: 'Hedera', ICP: 'ICP', INJ: 'Injective',
  SEI: 'Sei', TIA: 'Celestia', ENA: 'Ethena', WLD: 'Worldcoin', ORDI: 'Ordi', FET: 'Fetch.ai',
  RENDER: 'Render', AAVE: 'Aave', CRV: 'Curve', JUP: 'Jupiter', PYTH: 'Pyth', STX: 'Stacks',
  IMX: 'Immutable', GALA: 'Gala', SAND: 'Sandbox', MANA: 'Decentraland', APE: 'ApeCoin',
  EIGEN: 'EigenLayer', TAO: 'Bittensor', DYDX: 'dYdX', RUNE: 'THORChain', KAS: 'Kaspa',
  ENS: 'ENS', LDO: 'Lido', MKR: 'Maker', ONDO: 'Ondo', STRK: 'Starknet', ZK: 'ZKsync',
  NOT: 'Notcoin', PENGU: 'Pudgy Penguins', TRUMP: 'Trump', FARTCOIN: 'Fartcoin',
  PAXG: '黃金代幣', DOGS: 'Dogs', NEIRO: 'Neiro', ACT: 'Act', PNUT: 'Peanut',
};

// 美股候選池（排名範圍；ranking 只會從這裡挑）
const US_ALWAYS = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'SPY', 'QQQ'];
const US_POOL = [
  ['AAPL', '蘋果'], ['MSFT', '微軟'], ['NVDA', '輝達'], ['AMZN', '亞馬遜'], ['META', 'Meta'],
  ['GOOGL', '谷歌A'], ['GOOG', '谷歌C'], ['TSLA', '特斯拉'], ['AMD', '超微'], ['INTC', '英特爾'],
  ['MU', '美光'], ['AVGO', '博通'], ['NFLX', '網飛'], ['PLTR', 'Palantir'], ['COIN', 'Coinbase'],
  ['SMCI', '美超微'], ['MARA', 'Marathon'], ['RIOT', 'Riot'], ['HOOD', 'Robinhood'], ['SOFI', 'SoFi'],
  ['F', '福特'], ['NIO', '蔚來'], ['RIVN', 'Rivian'], ['LCID', 'Lucid'], ['AAL', '美國航空'],
  ['CCL', '嘉年華郵輪'], ['UBER', '優步'], ['DIS', '迪士尼'], ['BAC', '美國銀行'], ['WFC', '富國銀行'],
  ['T', 'AT&T'], ['VZ', '威瑞森'], ['PFE', '輝瑞'], ['XOM', '埃克森美孚'], ['ORCL', '甲骨文'],
  ['CRM', 'Salesforce'], ['QCOM', '高通'], ['ARM', '安謀'], ['DELL', '戴爾'], ['WMT', '沃爾瑪'],
  ['SNAP', 'Snap'], ['BABA', '阿里巴巴'], ['GME', '遊戲驛站'], ['AMC', 'AMC院線'],
  ['SPY', '標普500 ETF'], ['QQQ', '那斯達克 ETF'], ['IWM', '羅素2000 ETF'],
  ['SOXL', '半導體3X ETF'], ['TQQQ', '納指3X ETF'],
];

// 台股候選池（代號, 名稱）
const TW_ALWAYS = ['2330TW', '2317TW', '2454TW', '2303TW', '2603TW', '2609TW', '3008TW', '2412TW', '2882TW', '0050TW'];
const TW_POOL = [
  ['2330', '台積電'], ['2317', '鴻海'], ['2454', '聯發科'], ['2303', '聯電'], ['2603', '長榮'],
  ['2609', '陽明'], ['2615', '萬海'], ['2618', '長榮航'], ['2610', '華航'], ['2002', '中鋼'],
  ['2882', '國泰金'], ['2881', '富邦金'], ['2891', '中信金'], ['2886', '兆豐金'], ['2884', '玉山金'],
  ['2883', '開發金'], ['2888', '新光金'], ['2892', '第一金'], ['2408', '南亞科'], ['3231', '緯創'],
  ['2382', '廣達'], ['3034', '聯詠'], ['2379', '瑞昱'], ['2357', '華碩'], ['2324', '仁寶'],
  ['2356', '英業達'], ['2353', '宏碁'], ['3711', '日月光投控'], ['2409', '友達'], ['3481', '群創'],
  ['2344', '華邦電'], ['2337', '旺宏'], ['6770', '力積電'], ['2308', '台達電'], ['3008', '大立光'],
  ['2412', '中華電'], ['1301', '台塑'], ['1303', '南亞'], ['2027', '大成鋼'], ['1605', '華新'],
  ['3661', '世芯-KY'], ['3443', '創意'], ['2345', '智邦'],
  ['0050', '元大台灣50'], ['0056', '元大高股息'], ['00878', '國泰永續高股息'],
  ['00919', '群益台灣精選高息'], ['00929', '復華台灣科技優息'], ['00632R', '元大台灣50反1'],
];

// ============================================================
// 排名：近 30 天成交量
// ============================================================

// 加密：Binance 24h 榜取前 60 候選 → 各抓 30 根日K 加總成交額（USDT）→ 前 20
async function rankCrypto() {
  console.log('[rank] 加密貨幣：Binance 近 30 天成交額排名…');
  const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`);
  const tickers = await res.json();
  const usdt = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({ base: t.symbol.slice(0, -4), symbol: t.symbol, qv24: +t.quoteVolume }))
    .filter(t => !CRYPTO_EXCLUDE.has(t.base))
    .filter(t => !/(UP|DOWN|BULL|BEAR)$/.test(t.base))
    .filter(t => t.qv24 > 0);
  usdt.sort((a, b) => b.qv24 - a.qv24);
  const candidates = usdt.slice(0, 60);
  const scored = [];
  for (const c of candidates) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${c.symbol}&interval=1d&limit=30`);
      if (!r.ok) continue;
      const rows = await r.json();
      const vol30 = rows.reduce((s, k) => s + (+k[7] || 0), 0); // k[7] = quote asset volume
      scored.push({ ...c, vol30 });
    } catch { /* skip */ }
    await sleep(80);
  }
  scored.sort((a, b) => b.vol30 - a.vol30);
  const picked = new Map();
  for (const s of scored.slice(0, TOP_N)) picked.set(s.base, s);
  for (const base of CRYPTO_ALWAYS) {
    if (!picked.has(base)) {
      const found = scored.find(s => s.base === base) || usdt.find(s => s.base === base);
      if (found) picked.set(base, found);
    }
  }
  console.log(`  -> ${[...picked.keys()].join(', ')}`);
  return [...picked.values()].map(s => ({
    key: s.base,
    name: CRYPTO_NAMES[s.base] ? `${s.base} ${CRYPTO_NAMES[s.base]}` : s.base,
    category: 'crypto',
    pointValue: 1,
    sizeUnit: '顆',
    sizeDecimals: 2,   // manifest 會依實際價位覆寫
    fetch: {
      type: 'binance', ticker: s.symbol,
      tfs: CRYPTO_1H[s.base] ? ['1d', '1h'] : ['1d'],
      hFull: CRYPTO_1H[s.base] === 'full',
    },
  }));
}

// Yahoo：candidates 各抓 1 個月日K，加總成交量（股數）→ 前 20 ＋ 保底
async function rankYahooPool(pool, always, makeEntry, label) {
  console.log(`[rank] ${label}：候選池 ${pool.length} 檔近 30 天成交量排名…`);
  const scored = [];
  for (const [ticker, name] of pool) {
    try {
      const entry = makeEntry(ticker, name);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(entry.fetch.ticker)}?range=1mo&interval=1d`;
      const r = await fetch(url, { headers: YH });
      if (!r.ok) { console.warn(`  !! ${ticker} rank HTTP ${r.status}`); continue; }
      const j = await r.json();
      const q = j?.chart?.result?.[0]?.indicators?.quote?.[0];
      const vol30 = (q?.volume || []).reduce((s, v) => s + (v || 0), 0);
      if (vol30 > 0) scored.push({ entry, vol30 });
    } catch (e) { console.warn(`  !! ${ticker} rank failed: ${e.message}`); }
    await sleep(250);
  }
  scored.sort((a, b) => b.vol30 - a.vol30);
  const picked = new Map();
  for (const s of scored.slice(0, TOP_N)) picked.set(s.entry.key, s.entry);
  for (const key of always) {
    if (!picked.has(key)) {
      const found = scored.find(s => s.entry.key === key);
      if (found) picked.set(key, found.entry);
    }
  }
  console.log(`  -> ${[...picked.keys()].join(', ')}`);
  return [...picked.values()];
}

const makeUSEntry = (ticker, name) => ({
  key: ticker, name: `${ticker} ${name}`, category: 'us',
  pointValue: 1, sizeUnit: '股', sizeDecimals: 0,
  fetch: { type: 'yahoo', ticker, tfs: ['1d'] },
});
const makeTWEntry = (code, name) => ({
  key: `${code}TW`, name: `${code} ${name}`, category: 'tw',
  pointValue: 1 / TWD_USD, sizeUnit: '股', sizeDecimals: 0,
  fetch: { type: 'yahoo', ticker: `${code}.TW`, tfs: ['1d'] },
});

// ============================================================
// 抓取
// ============================================================
async function writeJson(file, candles, meta) {
  const out = {
    symbol: meta.symbol,
    interval: meta.interval,
    source: meta.source,
    fetchedAt: new Date().toISOString(),
    count: candles.length,
    firstTime: candles[0]?.time,
    lastTime: candles[candles.length - 1]?.time,
    candles,
  };
  await fs.writeFile(path.join(DATA_DIR, file), JSON.stringify(out));
  console.log(`  -> ${file}  (${candles.length} bars)`);
}

async function fetchBinance(ticker, interval, startTs) {
  const url = 'https://api.binance.com/api/v3/klines';
  const limit = 1000;
  const all = [];
  let startTime = startTs;
  while (startTime < NOW_TS) {
    const u = `${url}?symbol=${ticker}&interval=${interval}&startTime=${startTime}&limit=${limit}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Binance ${ticker} ${interval} HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) {
      all.push({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    }
    const lastOpenTime = rows[rows.length - 1][0];
    if (rows.length < limit) break;
    startTime = lastOpenTime + 1;
    await sleep(120);
  }
  return all;
}

async function fetchYahoo(ticker, interval) {
  const period2 = Math.floor(NOW_TS / 1000);
  const period1 = interval === '1h'
    ? period2 - 60 * 60 * 24 * 720
    : Math.floor(START_TS / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
  const res = await fetch(url, { headers: YH });
  if (!res.ok) throw new Error(`Yahoo ${ticker} HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker} no result: ${JSON.stringify(j).slice(0, 200)}`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: +o, high: +h, low: +l, close: +c, volume: +(v || 0) });
  }
  return candles;
}

async function fetchFinMindTXFDaily() {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${START_DATE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200 || !Array.isArray(j.data)) {
    throw new Error(`FinMind error: ${JSON.stringify(j).slice(0, 200)}`);
  }
  const byDate = new Map();
  for (const row of j.data) {
    if (row.trading_session && row.trading_session !== 'position') continue; // 一般盤
    const d = row.date, cd = row.contract_date;
    if (!d || !cd) continue;
    if (cd.length === 6) {
      const cm = `${cd.slice(0, 4)}-${cd.slice(4, 6)}-01`;
      if (new Date(cm).getTime() < new Date(d).getTime() - 32 * 86400_000) continue;
    }
    const exist = byDate.get(d);
    if (!exist || cd < exist.contract_date) byDate.set(d, row);
  }
  const candles = [];
  for (const [d, r] of byDate) {
    const t = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
    const o = +r.open, h = +r.max, l = +r.min, c = +r.close, v = +(r.volume || 0);
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    candles.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
  }
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

async function fetchSymbol(entry) {
  const f = entry.fetch;
  console.log(`[${entry.key}] ${entry.name} (${f.type})`);

  if (f.type === 'binance') {
    for (const tf of f.tfs) {
      const startTs = (tf === '1h' && !f.hFull) ? NOW_TS - 720 * 86400_000 : START_TS;
      const candles = await fetchBinance(f.ticker, tf === '1d' ? '1d' : '1h', startTs);
      await writeJson(`${entry.key}_${tf}.json`, candles, { symbol: f.ticker, interval: tf, source: 'Binance' });
    }
    return;
  }
  if (f.type === 'yahoo') {
    for (const tf of f.tfs) {
      try {
        const candles = await fetchYahoo(f.ticker, tf);
        if (!candles.length) throw new Error('empty result');
        await writeJson(`${entry.key}_${tf}.json`, candles, { symbol: f.ticker, interval: tf, source: 'Yahoo Finance' });
      } catch (e) {
        console.warn(`  !! ${entry.key} ${tf} failed: ${e.message}`);
      }
      await sleep(300);
    }
    return;
  }
  if (f.type === 'txf') {
    try {
      const d = await fetchFinMindTXFDaily();
      await writeJson('TXF_1d.json', d, { symbol: 'TXF', interval: '1d', source: 'FinMind' });
    } catch (e) {
      console.warn(`  !! TXF daily from FinMind failed: ${e.message}; fallback ^TWII`);
      const d = await fetchYahoo('^TWII', '1d');
      await writeJson('TXF_1d.json', d, { symbol: 'TXF', interval: '1d', source: 'Yahoo ^TWII proxy' });
    }
    try {
      const h = await fetchYahoo('^TWII', '1h');
      await writeJson('TXF_1h.json', h, { symbol: 'TXF', interval: '1h', source: 'Yahoo ^TWII proxy' });
    } catch (e) {
      console.warn(`  !! TXF 1h failed: ${e.message}`);
    }
  }
}

// ============================================================
// Manifest：依 registry + 磁碟實際檔案產出 symbols.json
// 加密幣的 sizeDecimals 依最新價位自動決定（高價幣 4 位、低價幣 0 位）
// ============================================================
async function writeManifest(registry) {
  const symbols = [];
  for (const entry of registry) {
    const tfs = [];
    let firstTime = null, lastTime = null, lastClose = null;
    const barCounts = {};
    for (const tf of entry.fetch.tfs) {
      const file = path.join(DATA_DIR, `${entry.key}_${tf}.json`);
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!raw.count) continue;
        tfs.push(tf);
        barCounts[tf] = raw.count;
        if (tf === '1d') {
          firstTime = raw.firstTime;
          lastTime = raw.lastTime;
          lastClose = raw.candles?.[raw.candles.length - 1]?.close ?? null;
        }
      } catch { /* 檔案不存在或損壞 → 略過該 tf */ }
    }
    if (!tfs.length) continue;
    let sizeDecimals = entry.sizeDecimals;
    if (entry.category === 'crypto' && lastClose != null) {
      sizeDecimals = lastClose >= 1000 ? 4 : lastClose >= 10 ? 2 : 0;
    }
    symbols.push({
      key: entry.key,
      name: entry.name,
      category: entry.category,
      pointValue: entry.pointValue,
      sizeUnit: entry.sizeUnit,
      sizeDecimals,
      tfs,
      barCounts,
      firstTime,
      lastTime,
    });
  }
  const out = {
    generatedAt: new Date().toISOString(),
    categories: { futures: '期指', crypto: '加密貨幣', us: '美股', tw: '台股' },
    symbols,
  };
  await fs.writeFile(path.join(DATA_DIR, 'symbols.json'), JSON.stringify(out, null, 1));
  console.log(`\n[manifest] symbols.json → ${symbols.length} 檔標的`);
}

// ============================================================
// main
// ============================================================
await fs.mkdir(DATA_DIR, { recursive: true });

const rawArgs = process.argv.slice(2);
const manifestOnly = rawArgs.includes('--manifest-only');
const keyArgs = rawArgs.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

async function loadCachedRegistry() {
  try {
    return JSON.parse(await fs.readFile(REGISTRY_CACHE, 'utf8'));
  } catch { return null; }
}

let registry;
if (manifestOnly || keyArgs.length) {
  registry = await loadCachedRegistry();
  if (!registry) {
    console.error('找不到 registry-cache.json，請先跑一次完整的 npm run fetch');
    process.exit(1);
  }
} else {
  // 完整執行：先排名決定標的組成
  const [crypto, us, tw] = [
    await rankCrypto(),
    await rankYahooPool(US_POOL, US_ALWAYS, makeUSEntry, '美股'),
    await rankYahooPool(TW_POOL, TW_ALWAYS, makeTWEntry, '台股'),
  ];
  registry = [...FUTURES, ...crypto, ...us, ...tw];
  await fs.writeFile(REGISTRY_CACHE, JSON.stringify(registry, null, 1));
  console.log(`\n[registry] 本次組成：期指 ${FUTURES.length}、加密 ${crypto.length}、美股 ${us.length}、台股 ${tw.length}\n`);
}

if (!manifestOnly) {
  const targets = keyArgs.length
    ? registry.filter(r => keyArgs.includes(r.key.toUpperCase()))
    : registry;
  console.log(`[fetch] targets = ${targets.map(t => t.key).join(', ')}`);
  console.log(`[fetch] data dir = ${DATA_DIR}\n`);
  for (const entry of targets) {
    try {
      await fetchSymbol(entry);
    } catch (e) {
      console.error(`[${entry.key}] FAILED:`, e.message);
    }
  }
}
await writeManifest(registry);
console.log('Done.');
