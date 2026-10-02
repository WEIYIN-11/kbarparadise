import { applyPriceFormat, chart, renderChart } from './chart.js';
import { STORAGE_KEYS, store, symInfo } from './constants.js';
import { loadCandles } from './data.js';
import { resetPendingPoints, updatePosToolButtons } from './drawings.js';
import {
  _blownUp,
  _fuseNotified,
  clearOrderTouched,
  closePosition,
  refreshOrderForm,
  renderPositions,
} from './orders.js';
import { loadAndStart, stopPlay, syncTopbarUI, updateReplayInfo } from './replay.js';
import { state } from './state.js';
import { saveStorage } from './storage.js';
import { clearReviewLines, renderReport, renderTrades, updateHotStats } from './trades.js';
import { $, $$, escHtml, fmtDateTime, fmtMoney, priceDp, showToast, uid } from './util.js';

// 盲測模式（隨機標的、隱藏名稱與日期、價格正規化）
// ============================================================
const BLIND_CONTEXT_BARS = 60; // 起始點前至少保留的歷史根數
const BLIND_BASE_PRICE = 100; // 正規化後的起始價

function blindPool(cats, tf) {
  return Object.values(store.SYMBOLS).filter(
    (s) => cats.includes(s.category) && s.tfs.includes(tf),
  );
}

function getBlindSetupOpts() {
  const cats = [...$$('#blind-cats input:checked')].map((c) => c.value);
  const tf = $('blind-tf').value;
  const playBars = +$('blind-len').value;
  return { cats, tf, playBars };
}

function updateBlindPoolHint() {
  const { cats, tf } = getBlindSetupOpts();
  const pool = blindPool(cats, tf);
  // 列出各類別檔數，讓使用者清楚知道會從哪些類別抽（只會抽有勾選的）
  const parts = ['futures', 'crypto', 'us', 'tw']
    .filter((c) => cats.includes(c))
    .map((c) => ({ c, n: pool.filter((s) => s.category === c).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${store.CATEGORY_LABELS[x.c] || x.c} ${x.n}`)
    .join('・');
  $('blind-pool-hint').textContent = pool.length
    ? `隨機池 ${pool.length} 檔（${parts}）— 只會從打勾的類別抽 1 檔`
    : '⚠️ 沒有符合條件的標的（1 小時僅期指與 BTC/ETH/SOL 有資料）';
}

function openBlindSetup() {
  if (state.blind) {
    showToast('盲測已在進行中', 'error');
    return;
  }
  $('blind-setup-modal').classList.add('show');
  updateBlindPoolHint();
}

async function startBlindSession() {
  const { cats, tf, playBars } = getBlindSetupOpts();
  if (!cats.length) {
    showToast('請至少勾選一個類別', 'error');
    return;
  }
  const pool = blindPool(cats, tf);
  if (!pool.length) {
    showToast('沒有符合條件的標的', 'error');
    return;
  }
  stopPlay();
  // 隨機抽標的；資料長度不足的換下一檔
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  let picked = null,
    candles = null;
  for (const s of shuffled) {
    const c = await loadCandles(s.key, tf);
    if (c.length >= BLIND_CONTEXT_BARS + playBars + 10) {
      picked = s;
      candles = c;
      break;
    }
  }
  if (!picked) {
    showToast('標的資料長度不足，請縮短測驗長度', 'error');
    return;
  }
  const maxStart = candles.length - playBars - 1;
  const startIndex =
    BLIND_CONTEXT_BARS + Math.floor(Math.random() * (maxStart - BLIND_CONTEXT_BARS + 1));
  state.blind = {
    id: uid(),
    symbol: picked.key,
    timeframe: tf,
    scale: BLIND_BASE_PRICE / candles[startIndex].close,
    startIndex,
    endIndex: startIndex + playBars,
    cursorIndex: startIndex,
    playBars,
    startedAt: Date.now(),
  };
  $('blind-setup-modal').classList.remove('show');
  saveStorage();
  await enterBlindReplay();
  showToast('🎲 盲測開始！標的與日期已隱藏', 'success');
}

// 依 state.blind 進入盲測回放（新開始與載入續玩共用）
async function enterBlindReplay() {
  const b = state.blind;
  stopPlay();
  if (typeof clearReviewLines === 'function') clearReviewLines();
  resetPendingPoints();
  state.posTool = null;
  updatePosToolButtons();
  const raw = await loadCandles(b.symbol, b.timeframe);
  if (!raw.length) {
    showToast('盲測資料載入失敗，已取消本輪', 'error');
    state.blind = null;
    saveStorage();
    syncTopbarUI();
    await loadAndStart();
    return;
  }
  state.symbol = b.symbol;
  state.timeframe = b.timeframe;
  // 價格正規化：起始價 = 100，避免從價位認出標的（點值同步換算，金額不受影響）
  // 成交量也同步正規化（起始前 60 根平均 ≈ 100）：量級差 3~4 個數量級會洩漏資產類別
  // （台股動輒千萬股、BTC 只有幾萬顆）；等比縮放不改變形態，VWAP/OBV 等比例型指標不受影響
  const vFrom = Math.max(0, b.startIndex - BLIND_CONTEXT_BARS);
  const vSlice = raw.slice(vFrom, b.startIndex + 1);
  const vAvg = vSlice.reduce((s, c) => s + (c.volume || 0), 0) / (vSlice.length || 1);
  const vScale = vAvg > 0 ? 100 / vAvg : 1;
  state.candles = raw.map((c) => ({
    time: c.time,
    open: c.open * b.scale,
    high: c.high * b.scale,
    low: c.low * b.scale,
    close: c.close * b.scale,
    volume: (c.volume || 0) * vScale,
  }));
  state.cursorIndex = Math.min(b.cursorIndex ?? b.startIndex, b.endIndex);
  applyPriceFormat();
  chart.timeScale().applyOptions({ visible: false }); // 日期隱藏
  syncTopbarUI();
  renderChart();
  updateReplayInfo();
  clearOrderTouched();
  refreshOrderForm();
  renderPositions();
  renderTrades();
  renderReport();
  updateHotStats();
}

// 結束按鈕：無交易可直接放棄，有交易則結算揭曉
function requestEndBlind() {
  if (!state.blind) return;
  const hasTrades = state.trades.some((t) => t.blindId === state.blind.id);
  const hasOpen = state.positions.some((p) => p.status === 'open' && p.blindId === state.blind.id);
  if (!hasTrades && !hasOpen) {
    if (confirm('這輪還沒有任何交易，要放棄盲測嗎？（不留紀錄，直接揭曉）'))
      finishBlindSession('無交易放棄', { skipHistory: true });
    return;
  }
  if (confirm('確定結束盲測？未平倉部位會以現價自動平倉，並揭曉標的。'))
    finishBlindSession('手動結束');
}

function finishBlindSession(endReason, opts = {}) {
  const b = state.blind;
  if (!b) return;
  stopPlay();
  // 本輪未平倉部位以現價自動平倉
  const bar = state.candles[Math.min(state.cursorIndex, state.candles.length - 1)];
  // 未成交的掛單直接取消（不算交易）
  state.positions = state.positions.filter((p) => !(p.status === 'pending' && p.blindId === b.id));
  const openPos = state.positions.filter((p) => p.status === 'open' && p.blindId === b.id);
  for (const p of openPos) {
    closePosition(p, bar.close, '盲測結束平倉', bar.time, endReason || '');
  }
  // 揭曉即還原：本輪交易的價格從正規化值換回真實價格（點值同步換算，盈虧與 R 不變）
  // 否則紀錄會出現「NQ @ 102」這種正規化價位，看起來像資料錯誤
  const toReal = (v) => (v == null ? null : +(v / b.scale).toFixed(priceDp(v / b.scale)));
  for (const t of state.trades) {
    if (t.blindId !== b.id || t.pricesRestored) continue;
    t.entryPrice = toReal(t.entryPrice);
    t.exitPrice = toReal(t.exitPrice);
    t.stopLoss = toReal(t.stopLoss);
    t.takeProfit = toReal(t.takeProfit);
    if (t.pnlPts != null) t.pnlPts = t.pnlPts / b.scale;
    if (t.pv != null) t.pv = t.pv * b.scale;
    t.pricesRestored = true;
  }
  // 統計本輪
  const trades = state.trades.filter((t) => t.blindId === b.id);
  const longs = trades.filter((t) => t.side === 'long');
  const shorts = trades.filter((t) => t.side === 'short');
  const wins = trades.filter((t) => t.pnl > 0);
  const raw = state.cache[`${b.symbol}_${b.timeframe}`] || [];
  const endIdx = Math.min(state.cursorIndex, b.endIndex);
  const p0 = raw[b.startIndex]?.close,
    p1 = raw[endIdx]?.close;
  // R 序列（時間正序）→ 累積曲線 / 峰值回撤 / 獲利因子
  const chrono = [...trades].sort((x, y) => x.exitTime - y.exitTime);
  const rSeq = chrono.map((t) => t.rMultiple || 0);
  const rCurve = [0];
  let cum = 0,
    peak = 0,
    maxDD = 0;
  for (const r of rSeq) {
    cum += r;
    rCurve.push(+cum.toFixed(2));
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  const winR = rSeq.filter((r) => r > 0);
  const lossR = rSeq.filter((r) => r < 0);
  const grossWinR = winR.reduce((s, r) => s + r, 0);
  const grossLossR = Math.abs(lossR.reduce((s, r) => s + r, 0));
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const summary = {
    id: b.id,
    symbol: b.symbol,
    timeframe: b.timeframe,
    startTime: raw[b.startIndex]?.time ?? null,
    endTime: raw[endIdx]?.time ?? null,
    barsPlayed: endIdx - b.startIndex,
    finishedAt: Date.now(),
    trades: trades.length,
    longs: longs.length,
    shorts: shorts.length,
    longWins: longs.filter((t) => t.pnl > 0).length,
    shortWins: shorts.filter((t) => t.pnl > 0).length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    totalPnl,
    avgR: trades.length ? trades.reduce((s, t) => s + (t.rMultiple || 0), 0) / trades.length : 0,
    bhPct: p0 && p1 ? (p1 / p0 - 1) * 100 : null, // 同期間買進持有報酬（對照基準）
    // 量化績效卡欄位
    perfPct: state.settings.balance ? (totalPnl / state.settings.balance) * 100 : null,
    cumR: +cum.toFixed(2),
    maxDD: +maxDD.toFixed(2),
    // Infinity 經 JSON.stringify 會變 null，重整後 ∞ 會掉成「—」：改用旗標保存
    profitFactor: grossLossR > 0 ? +(grossWinR / grossLossR).toFixed(2) : null,
    profitFactorInf: grossLossR === 0 && grossWinR > 0,
    avgWinR: winR.length ? +(grossWinR / winR.length).toFixed(2) : null,
    avgLossR: lossR.length ? +(-(grossLossR / lossR.length)).toFixed(2) : null,
    rCurve,
  };
  // 爆倉收場要留痕：歷史列表若只看盈虧，看不出這輪是「被打到出局」還是「正常跑完」
  if (opts.blownUp) summary.blownUp = true;
  if (!opts.skipHistory) state.blindHistory.unshift(summary);
  delete state.drawings[`blind_${b.id}`]; // 盲測畫線用完即丟
  delete _fuseNotified[b.id]; // 該輪的熔斷計數一起收掉，不留殘值
  delete _blownUp[b.id]; // 同理：輪次結束，爆倉旗標不留殘值
  state.blind = null;
  saveStorage();
  showBlindResult(summary, opts.skipHistory);
  // 揭曉：回到該標的正常模式（原始價格、時間軸依使用者設定）
  chart.timeScale().applyOptions({ visible: state.timeAxisVisible });
  syncTopbarUI();
  loadAndStart();
}

// R 權益曲線 → inline SVG（正報酬綠線、負報酬紅線、0 軸虛線）
function rCurveSvg(curve, w = 430, h = 120) {
  if (!Array.isArray(curve) || curve.length < 2) return '';
  const min = Math.min(...curve, 0),
    max = Math.max(...curve, 0);
  const span = max - min || 1;
  const pad = 6;
  const px = (i) => pad + (i * (w - pad * 2)) / (curve.length - 1);
  const py = (v) => pad + ((max - v) * (h - pad * 2)) / span;
  const pts = curve.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const up = curve[curve.length - 1] >= 0;
  const color = up ? '#2be3a9' : '#ff5b6a';
  const zy = py(0).toFixed(1);
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;" preserveAspectRatio="none">
    <line x1="${pad}" x2="${w - pad}" y1="${zy}" y2="${zy}" stroke="rgba(149,152,161,0.25)" stroke-width="1" stroke-dasharray="4 4"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function showBlindResult(s, wasAbandoned) {
  const info = symInfo(s.symbol);
  const catLabel = store.CATEGORY_LABELS[info.category] || '';
  const period =
    s.startTime && s.endTime
      ? `${fmtDateTime(s.startTime, '1d')} ~ ${fmtDateTime(s.endTime, '1d')}`
      : '—';
  const n = s.trades || 0;
  const winCount = (s.longWins ?? 0) + (s.shortWins ?? 0);
  const lossCount = n - winCount;
  const sign = (v) => (v > 0 ? '+' : '');
  const ud = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');
  const num = (v, dp = 2, suffix = '') =>
    v == null || Number.isNaN(v) ? '—' : !isFinite(v) ? '∞' : `${sign(v)}${v.toFixed(dp)}${suffix}`;
  // 卡片：label / 值 / class / 註解
  const cards = [
    ['PERFORMANCE %', num(s.perfPct, 2, '%'), ud(s.perfPct), `本輪盈虧 ${fmtMoney(s.totalPnl)}`],
    ['CUMULATIVE R', num(s.cumR, 2, 'R'), ud(s.cumR), '全部交易 R 加總'],
    [
      'WIN RATE',
      s.winRate == null ? '—' : s.winRate.toFixed(1) + '%',
      (s.winRate ?? 0) >= 50 ? 'up' : 'down',
      `${winCount}W / ${lossCount}L`,
    ],
    ['EXPECTANCY', num(s.avgR, 2, 'R'), ud(s.avgR), '平均每單'],
    [
      'PROFIT FACTOR',
      s.profitFactorInf || s.profitFactor === Infinity
        ? '∞'
        : s.profitFactor == null
          ? '—'
          : s.profitFactor.toFixed(2),
      s.profitFactorInf || (s.profitFactor ?? 0) >= 1 ? 'up' : 'down',
      'Gross win R / loss R',
    ],
    [
      'MAX DD',
      s.maxDD == null ? '—' : '-' + s.maxDD.toFixed(2) + 'R',
      s.maxDD ? 'down' : '',
      'R 峰值回撤',
    ],
    ['AVG WIN', num(s.avgWinR, 2, 'R'), 'up', 'winning trades'],
    ['AVG LOSS', num(s.avgLossR, 2, 'R'), s.avgLossR != null ? 'down' : '', 'losing trades'],
    ['TRADES', String(n), '', `${s.longs ?? 0} 多 / ${s.shorts ?? 0} 空`],
    ['BUY & HOLD', num(s.bhPct, 2, '%'), ud(s.bhPct), '同期持有對照'],
  ];
  const curveHtml =
    Array.isArray(s.rCurve) && s.rCurve.length >= 2
      ? `
    <div class="perf-curve">
<div class="pc-title">R Equity Curve</div>
<div class="pc-sub">本輪盲測 · ${n} 筆 · ${num(Math.min(...s.rCurve), 2)}R → ${num(s.cumR, 2)}R</div>
${rCurveSvg(s.rCurve)}
<div class="pc-dates"><span>${s.startTime ? fmtDateTime(s.startTime, '1d') : ''}</span><span>${s.endTime ? fmtDateTime(s.endTime, '1d') : ''}</span></div>
    </div>`
      : '';
  $('blind-result-body').innerHTML = `
    <div class="blind-reveal">
<div class="blind-reveal-sym">${s.blownUp ? '💀' : '🎯'} ${escHtml(info.name)}${s.blownUp ? '（爆倉出局）' : ''}</div>
<div class="blind-reveal-meta">${escHtml(catLabel)} · ${s.timeframe === '1d' ? '日線' : '1 小時'} · ${period}（${s.barsPlayed} 根）</div>
    </div>
    <div class="perf-grid">
${cards
  .map(
    ([label, value, cls, sub]) => `
  <div class="perf-card">
    <div class="pl">${label}</div>
    <div class="pv ${cls}">${value}</div>
    <div class="ps">${escHtml(sub)}</div>
  </div>`,
  )
  .join('')}
    </div>
    ${curveHtml}
    ${n === 0 ? '<div class="field-hint" style="margin-top:10px;">這輪沒有下單——觀察也是練習，下輪試著找一個進場點。</div>' : ''}
    ${wasAbandoned ? '<div class="field-hint" style="margin-top:10px;">此輪未計入盲測紀錄。</div>' : ''}
  `;
  $('blind-result-modal').classList.add('show');
}

function wireBlindMode() {
  $('btn-blind').addEventListener('click', () => {
    if (state.blind) requestEndBlind();
    else openBlindSetup();
  });
  $('btn-blind-start').addEventListener('click', startBlindSession);
  $$('#blind-cats input').forEach((c) => c.addEventListener('change', updateBlindPoolHint));
  $('blind-tf').addEventListener('change', updateBlindPoolHint);
  $('blind-len').addEventListener('change', updateBlindPoolHint);
  // 關頁前保盲測進度（含 cursor），下次開啟可續玩
  window.addEventListener('beforeunload', () => {
    try {
      if (state.blind) {
        state.blind.cursorIndex = state.cursorIndex;
        localStorage.setItem(
          STORAGE_KEYS.blind,
          JSON.stringify({ active: state.blind, history: state.blindHistory }),
        );
      }
    } catch {}
  });
}

export { enterBlindReplay, finishBlindSession, openBlindSetup, wireBlindMode };
