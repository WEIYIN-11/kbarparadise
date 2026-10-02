import {
  backToLogin,
  clearAll,
  doGoogleSignIn,
  doSignOut,
  exportJson,
  goPlans,
  saveSettingsAction,
  sendMagicLink,
  setForceChooser,
  setupAuthListener,
  showLogin,
} from './auth.js';
import { enterBlindReplay, openBlindSetup, wireBlindMode } from './blind.js';
import { chart, initChart, initPaneResizer, setChartType } from './chart.js';
import { BUILTIN_SYMBOLS, store } from './constants.js';
import {
  clearAllDrawings,
  clearPosTool,
  initDrawCanvas,
  redrawDrawings,
  resetPendingPoints,
  setPosTool,
  setTool,
  syncFormToPosTool,
  toggleTimeAxis,
  undoLastDrawing,
} from './drawings.js';
import { renderIndicators, syncSubpaneRanges } from './indicators.js';
import {
  closeAllPositions,
  confirmManualClose,
  setOrderSide,
  submitOrder,
  updateCloseInfo,
  updateOrderSummary,
} from './orders.js';
import {
  deleteSelectedDrawing,
  dragState,
  initDragSLTP,
  recolorSelectedDrawing,
  selectDrawing,
} from './position-tools.js';
import {
  advanceBar,
  jumpToDate,
  loadAndStart,
  retreatBar,
  setSymbolTF,
  stopPlay,
  syncTopbarUI,
  togglePlay,
} from './replay.js';
import { state } from './state.js';
import { loadStorage, saveStorage } from './storage.js';
import { wireTemplatesPanel } from './templates.js';
import { switchSidePane } from './trades.js';
import { $, $$, escHtml, showToast } from './util.js';

// ---------- Wire events ----------
function wireEvents() {
  // Symbol / TF
  $('symbol-select').addEventListener('change', (e) =>
    setSymbolTF(e.target.value, state.timeframe),
  );
  $$('#tf-seg button').forEach((b) =>
    b.addEventListener('click', () => setSymbolTF(state.symbol, b.dataset.tf)),
  );
  // 圖表類型
  $$('#ctype-seg button').forEach((b) =>
    b.addEventListener('click', () => setChartType(b.dataset.ctype)),
  );

  // Replay
  $('btn-prev').addEventListener('click', () => {
    stopPlay();
    retreatBar(1);
  });
  $('btn-next').addEventListener('click', () => {
    stopPlay();
    advanceBar(1);
  });
  $('btn-skip10').addEventListener('click', () => {
    stopPlay();
    advanceBar(10);
  });
  $('btn-play').addEventListener('click', togglePlay);
  $('speed-slider').addEventListener('input', (e) => {
    state.playSpeed = +e.target.value;
    $('speed-val').textContent = e.target.value;
  });
  $('btn-jump').addEventListener('click', () => jumpToDate($('jump-date').value));

  // Side tabs
  $$('.side-tabs button').forEach((b) =>
    b.addEventListener('click', () => switchSidePane(b.dataset.pane)),
  );

  // 一鍵平倉（持倉中標題列）
  $('btn-close-all').addEventListener('click', closeAllPositions);

  // Order side
  $$('.order-side-toggle button').forEach((b) =>
    b.addEventListener('click', () => setOrderSide(b.dataset.orderSide)),
  );
  ['order-entry', 'order-sl', 'order-tp', 'order-risk'].forEach((id) => {
    const el = $(id);
    el.addEventListener('input', () => {
      el.dataset.touched = '1';
      updateOrderSummary();
      syncFormToPosTool(); // 部位工具開啟時，欄位改動即時反映到圖上
    });
  });
  $('btn-submit-order').addEventListener('click', submitOrder);

  // 選取繪圖浮動列的刪除鈕
  $('dsb-delete').addEventListener('click', deleteSelectedDrawing);

  // 平倉比例（分批出場）
  $$('#close-frac-row button').forEach((b) =>
    b.addEventListener('click', () => {
      store._closeFrac = +b.dataset.frac;
      $$('#close-frac-row button').forEach((x) => x.classList.toggle('active', x === b));
      updateCloseInfo();
    }),
  );

  // Modals
  $$('[data-close]').forEach((b) =>
    b.addEventListener('click', () => $(b.dataset.close).classList.remove('show')),
  );
  $('btn-confirm-close').addEventListener('click', confirmManualClose);

  // Settings
  $('btn-save-settings').addEventListener('click', saveSettingsAction);
  $('btn-export-json').addEventListener('click', exportJson);
  $('btn-clear-all').addEventListener('click', clearAll);
  $('btn-signout').addEventListener('click', () => {
    if (confirm('確定要登出？')) doSignOut();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // 拖曳進行中不接受回放快捷鍵：腳下的 K 棒在動會讓拖曳的參考價一直變
    if (dragState || state.drawingDrag || store.posToolDrag) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
    if (e.key === 'ArrowRight') {
      stopPlay();
      advanceBar(1);
    }
    if (e.key === 'ArrowLeft') {
      stopPlay();
      retreatBar(1);
    }
  });
}

// ---------- Login flow ----------
function wireLogin() {
  $('btn-google').addEventListener('click', () => {
    doGoogleSignIn();
  });
  $('btn-magiclink').addEventListener('click', sendMagicLink);
  $('btn-plans').addEventListener('click', () => {
    goPlans();
  });
  $('btn-switch-account').addEventListener('click', () => {
    setForceChooser(true); // 下一次 Google 登入強制跳帳號選擇器
    backToLogin();
    store._signOutPromise = window.sb?.auth.signOut().catch(() => {});
  });
  // 從 Skool 按上一頁若走 bfcache，狀態列會殘留「前往中…」看起來當掉
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) $('nomember-count').textContent = '';
  });
  $('login-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMagicLink();
  });
}

// ---------- Boot ----------
// 從 data/symbols.json 載入標的清單（失敗時退回內建三檔）
async function loadSymbolManifest() {
  try {
    const res = await fetch('data/symbols.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (Array.isArray(j.symbols) && j.symbols.length) {
      store.SYMBOLS = {};
      for (const s of j.symbols) store.SYMBOLS[s.key] = s;
      if (j.categories) store.CATEGORY_LABELS = j.categories;
    }
  } catch (e) {
    console.warn('symbols.json 載入失敗，使用內建標的', e);
    store.SYMBOLS = { ...BUILTIN_SYMBOLS };
  }
}

function populateSymbolSelect() {
  const sel = $('symbol-select');
  const cats = ['futures', 'crypto', 'us', 'tw'];
  sel.innerHTML = cats
    .map((cat) => {
      const items = Object.values(store.SYMBOLS).filter((s) => s.category === cat);
      if (!items.length) return '';
      return (
        `<optgroup label="${escHtml(store.CATEGORY_LABELS[cat] || cat)}">` +
        items.map((s) => `<option value="${escHtml(s.key)}">${escHtml(s.name)}</option>`).join('') +
        '</optgroup>'
      );
    })
    .join('');
  if (store.SYMBOLS[state.symbol]) sel.value = state.symbol;
}

async function bootApp() {
  loadStorage();
  await loadSymbolManifest();
  if (!store.SYMBOLS[state.symbol]) state.symbol = Object.keys(store.SYMBOLS)[0];
  $('set-balance').value = state.settings.balance;
  initPaneResizer(); // 要在 initChart 前：圖表建立當下就吃到還原後的側欄寬度，省一次 resize
  initChart();
  initDrawCanvas();
  initDragSLTP();
  wireEvents();
  wireDrawingEvents();
  wireIndicatorsPanel();
  wireTemplatesPanel();
  wireBlindMode();
  populateSymbolSelect();
  // Sync subpane time scale with main chart pan/zoom
  chart.timeScale().subscribeVisibleLogicalRangeChange(syncSubpaneRanges);
  setOrderSide('long');
  if (state.blind && store.SYMBOLS[state.blind.symbol]) {
    await enterBlindReplay(); // 還原上次未完成的盲測
    showToast('已還原進行中的盲測', 'success');
  } else {
    state.blind = null;
    await loadAndStart();
    syncTopbarUI();
    openBlindSetup(); // 盲測為預設入口；「跳過」即回自由練習模式
  }
}

function wireIndicatorsPanel() {
  const panel = $('indicators-panel');
  const btn = $('btn-indicators');

  // 泛用路徑取值：'ema.0' / 'stoch' / 'sma.1' → 設定物件
  const cfgAtPath = (pathStr) => {
    let t = state.indicators;
    for (const seg of pathStr.split('.')) {
      if (t == null) return null;
      t = t[/^\d+$/.test(seg) ? +seg : seg];
    }
    return t ?? null;
  };
  // 泛用同步：所有 checkbox / 參數 / 顏色一律由 data-* 路徑驅動
  function syncUiFromState() {
    let activeCount = 0;
    panel.querySelectorAll('input[type="checkbox"][data-ind]').forEach((cb) => {
      const key = cb.dataset.ind;
      const m = key.match(/^(ema|sma)(\d+)$/);
      const cfg = m ? state.indicators[m[1]][+m[2]] : state.indicators[key];
      if (!cfg) return;
      cb.checked = !!cfg.enabled;
      if (cfg.enabled) activeCount++;
    });
    panel.querySelectorAll('input[data-ind-param]').forEach((inp) => {
      const path = inp.dataset.indParam;
      const parent = cfgAtPath(path.split('.').slice(0, -1).join('.'));
      const last = path.split('.').pop();
      if (parent && parent[last] != null) inp.value = parent[last];
    });
    panel.querySelectorAll('input[data-ind-color]').forEach((inp) => {
      const cfg = cfgAtPath(inp.dataset.indColor);
      if (cfg && cfg.color) inp.value = cfg.color;
    });
    btn.classList.toggle('has-active', activeCount > 0);
    btn.textContent = activeCount > 0 ? `📊 指標 (${activeCount})` : '📊 指標';
  }
  syncUiFromState();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('show');
  });
  // Click outside to close
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) {
      panel.classList.remove('show');
    }
  });

  // Toggle checkboxes
  panel.querySelectorAll('input[type="checkbox"][data-ind]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.ind;
      const m = key.match(/^(ema|sma)(\d+)$/);
      const cfg = m ? state.indicators[m[1]][+m[2]] : state.indicators[key];
      if (!cfg) return;
      cfg.enabled = cb.checked;
      saveStorage();
      syncUiFromState();
      // Trigger re-render
      const visible = state.candles.slice(0, state.cursorIndex + 1);
      renderIndicators(visible);
      redrawDrawings();
    });
  });

  // Number params
  panel.querySelectorAll('input[type="number"][data-ind-param]').forEach((input) => {
    input.addEventListener('change', () => {
      const path = input.dataset.indParam.split('.');
      // path examples: 'ema.0.period', 'bb.period', 'macd.fast'
      let target = state.indicators;
      for (let i = 0; i < path.length - 1; i++)
        target = target[path[i].match(/^\d+$/) ? +path[i] : path[i]];
      const last = path[path.length - 1];
      target[last] = +input.value;
      saveStorage();
      syncUiFromState();
      const visible = state.candles.slice(0, state.cursorIndex + 1);
      renderIndicators(visible);
      redrawDrawings();
    });
  });

  // Color inputs（泛用：'ema.0' / 'sma.1' / 'vwap'）
  panel.querySelectorAll('input[type="color"][data-ind-color]').forEach((input) => {
    input.addEventListener('change', () => {
      const cfg = cfgAtPath(input.dataset.indColor);
      if (cfg) cfg.color = input.value;
      saveStorage();
      const visible = state.candles.slice(0, state.cursorIndex + 1);
      renderIndicators(visible);
    });
  });
}

function wireDrawingEvents() {
  // Tool buttons
  $$('.draw-toolbar button[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool || ''));
  });
  // 部位工具（TV 式多空框）
  $$('.draw-toolbar button[data-postool]').forEach((b) => {
    b.addEventListener('click', () => setPosTool(b.dataset.postool));
  });
  // Color swatches: change default color AND recolor selected drawing if any
  $$('#draw-color-row button').forEach((b) => {
    b.addEventListener('click', () => {
      state.drawColor = b.dataset.color;
      $$('#draw-color-row button').forEach((x) => x.classList.toggle('active', x === b));
      recolorSelectedDrawing(b.dataset.color);
    });
  });
  // Actions
  document
    .querySelector('.draw-toolbar [data-action="undo"]')
    .addEventListener('click', undoLastDrawing);
  document
    .querySelector('.draw-toolbar [data-action="clear"]')
    .addEventListener('click', clearAllDrawings);
  document
    .querySelector('.draw-toolbar [data-action="toggle-time"]')
    .addEventListener('click', toggleTimeAxis);
  // 磁鐵吸附
  $('btn-magnet').addEventListener('click', () => {
    state.magnet = !state.magnet;
    $('btn-magnet').classList.toggle('active', state.magnet);
    showToast(state.magnet ? '🧲 磁鐵開啟：取點吸附 OHLC' : '磁鐵關閉', 'success');
  });
  // 隱藏/顯示所有畫線
  $('btn-toggle-drawings').addEventListener('click', () => {
    state.drawingsHidden = !state.drawingsHidden;
    $('btn-toggle-drawings').classList.toggle('active', state.drawingsHidden);
    redrawDrawings();
    showToast(state.drawingsHidden ? '已隱藏所有畫線' : '已顯示畫線', 'success');
  });

  // ESC: cancel in-progress drawing OR deselect; Delete/Backspace: delete selected
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      if (state.tool) {
        if (state.pendingPoints.length) {
          resetPendingPoints();
          redrawDrawings();
          showToast('已取消', 'success');
        } else {
          setTool('');
        }
      } else if (state.posTool) {
        clearPosTool();
        showToast('已關閉部位工具', 'success');
      } else if (state.selectedDrawingId) {
        selectDrawing(null);
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedDrawingId) {
      e.preventDefault();
      deleteSelectedDrawing();
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  wireLogin();
  showLogin();
});

// Supabase becomes available asynchronously (ES module import).
// Hook auth state once it's ready.
if (window.sb) {
  setupAuthListener();
} else {
  window.addEventListener('supabase-ready', setupAuthListener, { once: true });
}

export { bootApp };
