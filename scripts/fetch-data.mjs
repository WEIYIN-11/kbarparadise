#!/usr/bin/env node
/**
 * 練功房資料抓取腳本
 *
 * 標的：NQ / BTC / TXF
 * 粒度：1d (日線, 2020-01-01 ~ 今日) + 1h (近 2 年, 部分標的)
 *
 * 來源：
 *   - BTC：Binance REST (1d + 1h, 2020-01-01 起)
 *   - NQ ：Stooq (1d nq.f) + Yahoo Finance (1h NQ=F, 限近 730 天)
 *   - TXF：FinMind (1d TX 連續近月) + Yahoo Finance (^TWII 1h proxy)
 *
 * 用法：
 *   node scripts/fetch-data.mjs            # 全部
 *   node scripts/fetch-data.mjs btc        # 只抓 BTC
 *   node scripts/fetch-data.mjs nq txf     # 抓多個
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const START_DATE = '2020-01-01';
const START_TS = new Date(`${START_DATE}T00:00:00Z`).getTime();
const NOW_TS = Date.now();

await fs.mkdir(DATA_DIR, { recursive: true });

const args = process.argv.slice(2).map(s => s.toLowerCase());
const allSyms = ['btc', 'nq', 'txf'];
const targets = args.length ? args.filter(a => allSyms.includes(a)) : allSyms;

console.log(`[fetch] targets = ${targets.join(', ')}`);
console.log(`[fetch] data dir = ${DATA_DIR}`);
console.log('');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const fullPath = path.join(DATA_DIR, file);
  await fs.writeFile(fullPath, JSON.stringify(out));
  console.log(`  -> ${file}  (${candles.length} bars, ${out.firstTime} ~ ${out.lastTime})`);
}

// ====== BTC: Binance ======
async function fetchBinance(interval, label) {
  const url = 'https://api.binance.com/api/v3/klines';
  const limit = 1000;
  const all = [];
  let startTime = START_TS;
  while (startTime < NOW_TS) {
    const u = `${url}?symbol=BTCUSDT&interval=${interval}&startTime=${startTime}&limit=${limit}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Binance ${interval} HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) {
      all.push({
        time: Math.floor(r[0] / 1000),
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
      });
    }
    const lastOpenTime = rows[rows.length - 1][0];
    if (rows.length < limit) break;
    startTime = lastOpenTime + 1;
    await sleep(100);
  }
  return { candles: all, source: 'Binance', symbol: 'BTCUSDT', interval: label };
}

async function fetchBTC() {
  console.log('[BTC] daily from Binance...');
  const d = await fetchBinance('1d', '1d');
  await writeJson('BTC_1d.json', d.candles, d);

  console.log('[BTC] 1h from Binance...');
  const h = await fetchBinance('1h', '1h');
  await writeJson('BTC_1h.json', h.candles, h);
}

// ====== Yahoo Finance via chart endpoint ======
// interval='1d': full history; interval='1h': only last ~730 days available
async function fetchYahoo(symbol, interval, fileLabel) {
  const period2 = Math.floor(NOW_TS / 1000);
  const period1 =
    interval === '1h'
      ? period2 - 60 * 60 * 24 * 720 // ~720 days back
      : Math.floor(START_TS / 1000); // 2020-01-01 for daily
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} no result: ${JSON.stringify(j).slice(0, 200)}`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i],
      h = q.high?.[i],
      l = q.low?.[i],
      c = q.close?.[i],
      v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: +o, high: +h, low: +l, close: +c, volume: +(v || 0) });
  }
  return { candles, source: 'Yahoo Finance', symbol: fileLabel, interval };
}

async function fetchNQ() {
  console.log('[NQ] daily from Yahoo (NQ=F)...');
  const d = await fetchYahoo('NQ=F', '1d', 'NQ');
  await writeJson('NQ_1d.json', d.candles, d);

  console.log('[NQ] 1h from Yahoo (NQ=F, ~720d limit)...');
  try {
    const h = await fetchYahoo('NQ=F', '1h', 'NQ');
    await writeJson('NQ_1h.json', h.candles, h);
  } catch (e) {
    console.warn(`  !! NQ 1h failed: ${e.message}`);
  }
}

// ====== TXF: FinMind daily (TaiwanFuturesDaily, data_id=TX, 近月) ======
async function fetchFinMindTXFDaily() {
  // FinMind provides multiple expiries; we want continuous near-month.
  // Strategy: take rows where contract_date is the closest active month for each trading day.
  // Easier: just fetch all TX rows and pick the row with the smallest contract_date >= trade date,
  // or use the row marked as the "near month" via filter on settlement_price > 0 plus min contract_date.
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=${START_DATE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
  const j = await res.json();
  if (j.status !== 200 || !Array.isArray(j.data)) {
    throw new Error(`FinMind error: ${JSON.stringify(j).slice(0, 200)}`);
  }
  // Group by date, pick near-month (smallest contract_date that is >= date), all-day session.
  const byDate = new Map();
  for (const row of j.data) {
    if (row.trading_session && row.trading_session !== 'position') continue; // 一般盤
    const d = row.date;
    const cd = row.contract_date;
    if (!d || !cd) continue;
    if (cd.length === 6) {
      // YYYYMM e.g., 202404
      const cm = `${cd.slice(0, 4)}-${cd.slice(4, 6)}-01`;
      const dPlus = new Date(d).getTime();
      const cdPlus = new Date(cm).getTime();
      if (cdPlus < dPlus - 32 * 86400_000) continue; // skip already-expired
    }
    const exist = byDate.get(d);
    if (!exist || cd < exist.contract_date) byDate.set(d, row);
  }
  const candles = [];
  for (const [d, r] of byDate) {
    const t = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
    const o = +r.open,
      h = +r.max,
      l = +r.min,
      c = +r.close,
      v = +(r.volume || 0);
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    candles.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
  }
  candles.sort((a, b) => a.time - b.time);
  return { candles, source: 'FinMind', symbol: 'TXF', interval: '1d' };
}

async function fetchTXF() {
  console.log('[TXF] daily from FinMind (TX 近月)...');
  try {
    const d = await fetchFinMindTXFDaily();
    await writeJson('TXF_1d.json', d.candles, d);
  } catch (e) {
    console.warn(`  !! TXF daily from FinMind failed: ${e.message}`);
    console.log('[TXF] fallback: Yahoo ^TWII as proxy...');
    const d = await fetchYahoo('^TWII', '1d', 'TXF');
    await writeJson('TXF_1d.json', d.candles, d);
  }

  console.log('[TXF] 1h from Yahoo (^TWII proxy, ~720d)...');
  try {
    const h = await fetchYahoo('^TWII', '1h', 'TXF');
    await writeJson('TXF_1h.json', h.candles, h);
  } catch (e) {
    console.warn(`  !! TXF 1h failed: ${e.message}`);
  }
}

// ====== main ======
const fetchers = { btc: fetchBTC, nq: fetchNQ, txf: fetchTXF };
for (const t of targets) {
  try {
    await fetchers[t]();
    console.log('');
  } catch (e) {
    console.error(`[${t}] FAILED:`, e);
    console.log('');
  }
}

console.log('Done.');
