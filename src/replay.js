import { finishBlindSession } from './blind.js';
import { applyPriceFormat, renderChart } from './chart.js';
import { inScope, store, symInfo } from './constants.js';
import { loadCandles } from './data.js';
import { resetPendingPoints, updatePosToolButtons } from './drawings.js';
import {
  checkBlowUp,
  checkLossStreak,
  closePosition,
  refreshOrderForm,
  renderPositions,
} from './orders.js';
import { cancelLineDrag, dragState, onDrawingDragEnd } from './position-tools.js';
import { state } from './state.js';
import { saveStorage } from './storage.js';
import { clearReviewLines, renderReport, renderTrades, updateHotStats } from './trades.js';
import { $, $$, fmtDateTime, fmtPrice, showToast } from './util.js';

// ---------- Replay ----------
function setSymbolTF(sym, tf) {
  if (state.blind) {
    showToast('盲測進行中，無法切換標的/週期', 'error');
    syncTopbarUI();
    return;
  }
  const tfs = symInfo(sym).tfs;
  if (!tfs.includes(tf)) tf = tfs.includes('1d') ? '1d' : tfs[0];
  state.symbol = sym;
  state.timeframe = tf;
  syncTopbarUI();
  loadAndStart();
}

// Topbar UI 同步：下拉選單、週期按鈕可用性、盲測狀態
function syncTopbarUI() {
  const blind = !!state.blind;
  const sel = $('symbol-select');
  sel.style.display = blind ? 'none' : '';
  sel.disabled = blind;
  $('blind-chip').style.display = blind ? '' : 'none';
  if (!blind && store.SYMBOLS[state.symbol]) sel.value = state.symbol;
  $$('#tf-seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tf === state.timeframe);
    b.disabled = blind || !symInfo(state.symbol).tfs.includes(b.dataset.tf);
  });
  const bb = $('btn-blind');
  bb.textContent = blind ? '⏹ 結束盲測' : '🎲 盲測';
  bb.classList.toggle('blind-active', blind);
  $('jump-date').disabled = blind;
  $('btn-jump').disabled = blind;
}

async function loadAndStart() {
  stopPlay();
  if (typeof clearReviewLines === 'function') clearReviewLines(); // 換場景時移除檢討線
  if (dragState) cancelLineDrag(); // 進行中的線拖曳不可跨到新標的
  if (state.drawingDrag) onDrawingDragEnd();
  if (store._closeTargetId) {
    // 開著的平倉視窗屬於舊標的，一併收掉
    $('close-modal').classList.remove('show');
    store._closeTargetId = null;
  }
  // Reset in-progress drawing when switching context
  resetPendingPoints();
  state.posTool = null;
  if (typeof updatePosToolButtons === 'function') updatePosToolButtons();
  const candles = await loadCandles(state.symbol, state.timeframe);
  state.candles = candles;
  applyPriceFormat();
  if (!candles.length) {
    state.cursorIndex = -1;
    renderChart();
    updateReplayInfo();
    return;
  }
  // Default starting cursor: 30% into history (give some context for trading)
  state.cursorIndex = Math.floor(candles.length * 0.3);
  renderChart();
  updateReplayInfo();
  refreshOrderForm();
  renderPositions();
  renderTrades();
  renderReport();
  updateHotStats();
}

function updateReplayInfo() {
  const c = state.candles[state.cursorIndex];
  if (c) {
    if (state.blind) {
      const done = state.cursorIndex - state.blind.startIndex;
      $('replay-dt').textContent = '❓ 日期隱藏';
      $('replay-ix').textContent = `盲測 ${done} / ${state.blind.playBars} 根`;
    } else {
      $('replay-dt').textContent = fmtDateTime(c.time, state.timeframe);
      $('replay-ix').textContent = `K棒 ${state.cursorIndex + 1} / ${state.candles.length}`;
    }
  } else {
    $('replay-dt').textContent = '—';
    $('replay-ix').textContent = '—';
  }
}

function advanceBar(n = 1) {
  if (!state.candles.length) return;
  let blindDone = false;
  for (let i = 0; i < n; i++) {
    if (state.cursorIndex >= state.candles.length - 1) {
      stopPlay();
      break;
    }
    state.cursorIndex++;
    // Check SL/TP against the new bar
    const newBar = state.candles[state.cursorIndex];
    checkPositionTriggers(newBar);
    if (state.blind) {
      state.blind.cursorIndex = state.cursorIndex;
      if (state.cursorIndex >= state.blind.endIndex) {
        blindDone = true;
        break;
      }
    }
  }
  renderChart();
  updateReplayInfo();
  refreshOrderForm();
  renderPositions();
  updateHotStats();
  // 盲測進度每 10 根落地一次（原本只靠 beforeunload，瀏覽器崩潰或手機被回收就會退回舊位置）
  if (state.blind && state.cursorIndex % 10 === 0) saveStorage();
  // 爆倉檢查放在整段推進跑完後只做一次：權益要掃全部交易與部位，逐根算既昂貴，
  // 又會讓一次 advanceBar(10) 連彈好幾次提示。連播是每 tick 呼叫 advanceBar(1)，逐根照樣覆蓋到。
  // 排在 blindDone 前面：真的沒錢了就是出局，不該被記成「跑完設定長度」的正常收場。
  if (checkBlowUp()) return;
  if (blindDone) {
    stopPlay();
    finishBlindSession('跑完設定長度');
  }
}
function retreatBar(n = 1) {
  // Note: retreating doesn't undo trades — only changes the chart cursor
  if (!state.candles.length) return;
  const min = state.blind ? state.blind.startIndex : 0;
  state.cursorIndex = Math.max(min, state.cursorIndex - n);
  if (state.blind) state.blind.cursorIndex = state.cursorIndex;
  renderChart();
  updateReplayInfo();
  refreshOrderForm();
}

function startPlay() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  $('btn-play').textContent = '⏸';
  const speedToMs = (s) => Math.max(80, 1200 - (s - 1) * 130); // 1->1200ms, 10->30ms... clamp
  const tick = () => {
    advanceBar(1);
    if (state.isPlaying && state.cursorIndex < state.candles.length - 1) {
      state.playTimer = setTimeout(tick, speedToMs(state.playSpeed));
    } else {
      stopPlay();
    }
  };
  tick();
}
function stopPlay() {
  state.isPlaying = false;
  if (state.playTimer) {
    clearTimeout(state.playTimer);
    state.playTimer = null;
  }
  $('btn-play').textContent = '▶';
  // 盲測進度落地（含 cursor），中途重整可續玩
  if (state.blind) saveStorage();
}
function togglePlay() {
  state.isPlaying ? stopPlay() : startPlay();
}

function jumpToDate(dateStr) {
  if (state.blind) {
    showToast('盲測中無法跳日期', 'error');
    return;
  }
  if (!dateStr || !state.candles.length) return;
  const target = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
  // Find the first candle >= target
  let idx = state.candles.findIndex((c) => c.time >= target);
  if (idx < 0) idx = state.candles.length - 1;
  state.cursorIndex = idx;
  renderChart();
  updateReplayInfo();
  refreshOrderForm();
}

// ---------- SL/TP triggers ----------
function checkPositionTriggers(newBar) {
  let changed = false; // 需要重繪（成交或平倉都算）
  let didClose = false; // 真的有新平倉——只有這時才檢查連敗，掛單成交不該觸發熔斷
  for (const p of state.positions) {
    if (p.symbol !== state.symbol || p.timeframe !== state.timeframe || !inScope(p)) continue;
    // 時間守衛：回放檢討或倒退 K 棒時，游標會回到部位建立之前——
    // 那些「過去」的 K 棒不該觸發成交或停損停利（否則出場時間會早於進場時間）
    // 用 <= ：進場/成交當根本來就不檢查停損停利，倒退後重走那一根也不該補觸發
    // （否則會產生「出場時間 = 進場時間」、持有 0 根的假停損）
    const refTime = p.status === 'pending' ? (p.createdBarTime ?? p.entryTime) : p.entryTime;
    if (refTime != null && newBar.time <= refTime) continue;
    // 掛單：價格觸及進場價才成交；成交當根不檢查停損/停利（下一根才開始）
    if (p.status === 'pending') {
      if (newBar.low <= p.entryPrice && p.entryPrice <= newBar.high) {
        p.status = 'open';
        p.entryTime = newBar.time;
        p.chartTime = newBar.time;
        saveStorage();
        showToast(
          `✓ 掛單成交：${p.side === 'long' ? '多' : '空'}單 @ ${fmtPrice(p.entryPrice)}`,
          'success',
        );
        changed = true;
      }
      continue;
    }
    if (p.status !== 'open') continue;
    let exitPrice = null,
      exitReason = null;
    // 停損/停利可能未設（選填）——只檢查有設的那條
    if (p.side === 'long') {
      // SL fills first if both hit
      if (p.stopLoss != null && newBar.low <= p.stopLoss) {
        exitPrice = p.stopLoss;
        exitReason = '達停損';
      } else if (p.takeProfit != null && newBar.high >= p.takeProfit) {
        exitPrice = p.takeProfit;
        exitReason = '達停利';
      }
    } else {
      if (p.stopLoss != null && newBar.high >= p.stopLoss) {
        exitPrice = p.stopLoss;
        exitReason = '達停損';
      } else if (p.takeProfit != null && newBar.low <= p.takeProfit) {
        exitPrice = p.takeProfit;
        exitReason = '達停利';
      }
    }
    if (exitPrice != null) {
      closePosition(p, exitPrice, exitReason, newBar.time, '系統觸發 SL/TP');
      changed = true;
      didClose = true;
      // 若平倉視窗正對著這個部位，關掉它（否則會留下一個按了沒反應的死視窗）
      if (store._closeTargetId === p.id) {
        $('close-modal').classList.remove('show');
        store._closeTargetId = null;
      }
    }
  }
  if (changed) {
    renderTrades();
    renderReport();
    if (didClose) checkLossStreak();
  }
}

export {
  advanceBar,
  jumpToDate,
  loadAndStart,
  retreatBar,
  setSymbolTF,
  stopPlay,
  syncTopbarUI,
  togglePlay,
  updateReplayInfo,
};
