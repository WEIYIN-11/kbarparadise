import { state } from './state.js';
import { $, showToast } from './util.js';

// ---------- Data loading ----------
async function loadCandles(symbol, timeframe) {
  const key = `${symbol}_${timeframe}`;
  if (state.cache[key]) return state.cache[key];
  const file = `data/${symbol}_${timeframe}.json`;
  $('chart-loading').classList.remove('hidden');
  try {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
    const j = await res.json();
    state.cache[key] = j.candles || [];
    return state.cache[key];
  } catch (e) {
    console.error(e);
    showToast('資料載入失敗：' + e.message, 'error');
    return [];
  } finally {
    $('chart-loading').classList.add('hidden');
  }
}

export { loadCandles };
