import { posPV, store, symLabel } from './constants.js';
import { redrawDrawings, redrawPositionLines, resizeDrawCanvas } from './drawings.js';
import { renderIndicators, subCharts } from './indicators.js';
import { state } from './state.js';
import { saveStorage } from './storage.js';
import { $, $$, fmtDateTime, fmtPrice, priceDp, showToast } from './util.js';

// ---------- Chart ----------
let chart, candleSeries;
// Track price lines for drag: posId -> { entry, sl, tp } (each is an IPriceLine)
const posLineMap = new Map();

// Compute hypothetical P/L if position is closed at the given price
function pnlAtPrice(p, price) {
  const dir = p.side === 'long' ? 1 : -1;
  return (price - p.entryPrice) * dir * posPV(p) * p.size;
}
// Money string with explicit sign (+$1,234 / -$567)
function fmtMoneySigned(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const s = abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2);
  return (n < 0 ? '-$' : '+$') + Number(s).toLocaleString();
}
function slLineTitle(p, price, dragging) {
  return `🔻 SL ${fmtPrice(price)}  ${fmtMoneySigned(pnlAtPrice(p, price))}${dragging ? ' …' : ''}`;
}
function tpLineTitle(p, price, dragging) {
  return `🎯 TP ${fmtPrice(price)}  ${fmtMoneySigned(pnlAtPrice(p, price))}${dragging ? ' …' : ''}`;
}
function initChart() {
  const el = $('chart');
  chart = LightweightCharts.createChart(el, {
    layout: { background: { color: '#131722' }, textColor: '#9598a1' },
    grid: {
      vertLines: { color: 'rgba(42,46,57,0.55)' },
      horzLines: { color: 'rgba(42,46,57,0.55)' },
    },
    rightPriceScale: { borderColor: '#2a2e39' },
    timeScale: {
      borderColor: '#2a2e39',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  applyChartType(); // 依 settings.chartType 建立主圖 series（K棒/美國線/折線/面積）
  // TV 式 legend：無十字線時顯示最後一根，有十字線時顯示所指 K 棒
  chart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.seriesData.size) {
      updateLegend(null, null);
      return;
    }
    const c = param.seriesData.get(candleSeries);
    if (!c) return;
    updateLegend(c, param.time);
  });
  // 這裡不能只 applyOptions({})：lightweight-charts v4 沒開 autoSize 時 applyOptions 不碰尺寸，
  // 圖表會一直停在建立當下的寬高，價格↔座標換算跟著失準（畫線就會整條偏掉）
  window.addEventListener('resize', syncPaneChartSizes);
  // iOS Safari 轉向時 resize 事件時機不可靠（常常在版面還沒定案時就發），
  // 補一次延遲同步，否則轉向後畫布會停在舊尺寸溢出到側欄上
  window.addEventListener('orientationchange', () => setTimeout(syncPaneChartSizes, 250));
}

// ============================================================
// 版面分隔線（圖表區 ⇄ 側欄，可拖曳）
// ============================================================
const PANE_DEFAULT = { width: 340, height: 280 };
// minChart：圖表區的絕對下限，視窗窄到放不下時它優先於 side 的 min/max
const PANE_LIMIT = { minW: 260, maxW: 620, minChart: 320, minH: 160, maxHRatio: 0.7 };
let _paneRaf = 0;
let _syncingPanes = false;

// 900px 是 .main 由 row 轉 column 的斷點；用 matchMedia 讀同一個門檻，避免兩邊各寫一份數字
function isPaneColumn() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function clampSideWidth(px) {
  const main = $('main-pane');
  const resizer = $('pane-resizer');
  const total = (main && main.clientWidth) || window.innerWidth;
  const gap = (resizer && resizer.offsetWidth) || 12;
  // 視窗放不下時 minChart 蓋過 maxW，再蓋過 minW：先夾上限、後夾下限
  const cap = Math.min(PANE_LIMIT.maxW, total - PANE_LIMIT.minChart - gap);
  return Math.round(Math.max(PANE_LIMIT.minW, Math.min(cap, px)));
}

function clampSideHeight(px) {
  const main = $('main-pane');
  const total = (main && main.clientHeight) || window.innerHeight;
  const cap = Math.max(PANE_LIMIT.minH, Math.round(total * PANE_LIMIT.maxHRatio));
  return Math.round(Math.max(PANE_LIMIT.minH, Math.min(cap, px)));
}

// 只改 CSS 變數、不寫 .side 的 inline width/height，斷點切換時才不會有殘留的鎖死
function applyPaneVars() {
  const main = $('main-pane');
  if (!main) return;
  const s = state.settings;
  main.style.setProperty('--side-w', (s.sideWidth || PANE_DEFAULT.width) + 'px');
  main.style.setProperty('--side-h', (s.sideHeight || PANE_DEFAULT.height) + 'px');
}

// 版面尺寸一動就得把圖表拉回容器大小，否則 priceToCoordinate 還在用舊寬高，畫線座標會跑掉
function syncPaneChartSizes() {
  if (!chart) return;
  _syncingPanes = true;
  try {
    syncPaneChartSizesInner();
  } finally {
    _syncingPanes = false;
  }
}
function syncPaneChartSizesInner() {
  // 第三個參數 forceRepaint 一定要 true：不給的話 v4 只改外層 div 的 style，
  // 內部畫布與價格軸要等下一次 rAF 才跟上，而下面的 redrawDrawings() 會先用到舊的
  // priceToCoordinate，畫出來的線就會整條偏掉一幀（甚至沒有下一次重畫就永久偏）
  const el = $('chart');
  if (el && el.clientWidth > 0 && el.clientHeight > 0) {
    try {
      chart.resize(el.clientWidth, el.clientHeight, true);
    } catch {}
  }
  for (const name of Object.keys(subCharts)) {
    const box = document.querySelector(`#subpane-${name} .subpane-chart`);
    if (!box || !box.clientWidth || !box.clientHeight) continue;
    try {
      subCharts[name].chart.resize(box.clientWidth, box.clientHeight, true);
    } catch {}
  }
  // ResizeObserver 也會補這兩步，但它是下一幀才到；拖曳放手當下要立刻正確
  resizeDrawCanvas();
  redrawDrawings();
}

function initPaneResizer() {
  const bar = $('pane-resizer');
  if (!bar) return;
  state.settings.sideWidth = clampSideWidth(state.settings.sideWidth || PANE_DEFAULT.width);
  state.settings.sideHeight = clampSideHeight(state.settings.sideHeight || PANE_DEFAULT.height);
  applyPaneVars();

  let dragging = false,
    column = false;

  const moveTo = (ev) => {
    const rect = $('main-pane').getBoundingClientRect();
    if (column) state.settings.sideHeight = clampSideHeight(rect.bottom - ev.clientY);
    else state.settings.sideWidth = clampSideWidth(rect.right - ev.clientX);
    applyPaneVars();
  };

  bar.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    dragging = true;
    column = isPaneColumn();
    try {
      bar.setPointerCapture(ev.pointerId);
    } catch {} // 抓不到 capture 也不該讓整個拖曳掛掉
    bar.classList.add('dragging');
    document.body.classList.add('pane-resizing');
    document.body.classList.toggle('row', column);
    ev.preventDefault();
  });

  bar.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    moveTo(ev);
    // 拖曳中用 rAF 節流重量級的圖表重算；放手時另有一次同步的完整更新兜底
    if (!_paneRaf)
      _paneRaf = requestAnimationFrame(() => {
        _paneRaf = 0;
        syncPaneChartSizes();
      });
  });

  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    try {
      bar.releasePointerCapture(ev.pointerId);
    } catch {}
    bar.classList.remove('dragging');
    document.body.classList.remove('pane-resizing', 'row');
    if (_paneRaf) {
      cancelAnimationFrame(_paneRaf);
      _paneRaf = 0;
    }
    moveTo(ev);
    syncPaneChartSizes(); // 最終狀態一定同步跑完一次，不依賴 rAF 是否有排到
    saveStorage();
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  bar.addEventListener('dblclick', () => {
    if (isPaneColumn()) state.settings.sideHeight = clampSideHeight(PANE_DEFAULT.height);
    else state.settings.sideWidth = clampSideWidth(PANE_DEFAULT.width);
    applyPaneVars();
    syncPaneChartSizes();
    saveStorage();
    showToast('版面已回復預設', 'success');
  });
}

// TV 式左上角 legend（symbol · 週期 · O H L C ±chg）
function updateLegend(c, time) {
  if (!c) {
    c = state.candles[state.cursorIndex];
    time = c ? c.time : null;
  }
  if (!c) {
    $('chart-overlay').innerHTML = '';
    return;
  }
  // 折線/面積圖的 seriesData 只有 value
  if (c.close == null && c.value != null)
    c = { open: c.value, high: c.value, low: c.value, close: c.value };
  const ch = c.close - c.open;
  const chPct = c.open ? (ch / c.open) * 100 : 0;
  const chColor = ch >= 0 ? '#26a69a' : '#f7525f';
  const tfLabel = state.timeframe === '1d' ? 'D' : '1H';
  $('chart-overlay').innerHTML = `
    <span class="price">${symLabel(state.symbol)}</span> · ${tfLabel} · ${state.blind ? '❓' : time ? fmtDateTime(time, state.timeframe) : '—'}<br>
    O <span class="price" style="color:${chColor}">${fmtPrice(c.open)}</span>
    H <span class="price" style="color:${chColor}">${fmtPrice(c.high)}</span>
    L <span class="price" style="color:${chColor}">${fmtPrice(c.low)}</span>
    C <span class="price" style="color:${chColor}">${fmtPrice(c.close)}</span>
    <span style="color:${chColor}">${ch >= 0 ? '+' : ''}${fmtPrice(ch)} (${ch >= 0 ? '+' : ''}${chPct.toFixed(2)}%)</span>
  `;
}

// ---- 圖表類型（TV 式：K棒 / 美國線 / 折線 / 面積）----
function mainSeriesData(visible) {
  const t = state.settings.chartType || 'candles';
  if (t === 'line' || t === 'area') return visible.map((c) => ({ time: c.time, value: c.close }));
  return visible;
}
function applyChartType() {
  if (!chart) return;
  const t = state.settings.chartType || 'candles';
  const old = candleSeries;
  let s;
  if (t === 'bars') {
    s = chart.addBarSeries({ upColor: '#089981', downColor: '#f23645', thinBars: false });
  } else if (t === 'line') {
    s = chart.addLineSeries({ color: '#2962ff', lineWidth: 2 });
  } else if (t === 'area') {
    s = chart.addAreaSeries({
      lineColor: '#2962ff',
      lineWidth: 2,
      topColor: 'rgba(41,98,255,0.3)',
      bottomColor: 'rgba(41,98,255,0.02)',
    });
  } else {
    s = chart.addCandlestickSeries({
      upColor: '#089981',
      downColor: '#f23645',
      borderUpColor: '#089981',
      borderDownColor: '#f23645',
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
    });
  }
  candleSeries = s;
  if (old) {
    try {
      chart.removeSeries(old);
    } catch {}
  }
  // 舊 series 的價位線已隨之銷毀
  store.posLines = [];
  posLineMap.clear();
  applyPriceFormat();
  $$('#ctype-seg button').forEach((b) => b.classList.toggle('active', b.dataset.ctype === t));
}
function setChartType(t) {
  state.settings.chartType = t;
  applyChartType();
  renderChart();
  saveStorage();
}

// 依當前資料價位調整價格軸小數位（低價幣需要更多位數）
function applyPriceFormat() {
  if (!candleSeries) return;
  const last = state.candles[state.candles.length - 1];
  const dp = priceDp(last ? last.close : 100);
  candleSeries.applyOptions({
    priceFormat: { type: 'price', precision: dp, minMove: Math.pow(10, -dp) },
  });
}

function renderChart() {
  if (!candleSeries) return;
  const visible = state.candles.slice(0, state.cursorIndex + 1);
  candleSeries.setData(mainSeriesData(visible));
  updateLegend(null, null);
  // Draw position lines
  redrawPositionLines();
  // Update indicators based on visible candles
  renderIndicators(visible);
  // Auto-scroll to last
  if (visible.length > 0) {
    const len = visible.length;
    const from = Math.max(0, len - 120);
    chart.timeScale().setVisibleLogicalRange({ from, to: len + 5 });
  }
  redrawDrawings();
}

// ============================================================

export {
  _syncingPanes,
  applyPriceFormat,
  candleSeries,
  chart,
  fmtMoneySigned,
  initChart,
  initPaneResizer,
  pnlAtPrice,
  posLineMap,
  renderChart,
  setChartType,
  slLineTitle,
  syncPaneChartSizes,
  tpLineTitle,
};
