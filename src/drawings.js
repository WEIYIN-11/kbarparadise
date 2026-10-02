import {
  _syncingPanes,
  candleSeries,
  chart,
  fmtMoneySigned,
  posLineMap,
  slLineTitle,
  syncPaneChartSizes,
  tpLineTitle,
} from './chart.js';
import { TOOL_POINTS, getPointValue, inScope, store, symLabel } from './constants.js';
import { ichimokuCloudCache, sarCache } from './indicators.js';
import { calcOrderSize, setOrderSide, updateOrderSummary } from './orders.js';
import { state } from './state.js';
import {
  drawingsKey,
  getActiveTplStyle,
  getCurrentDrawings,
  lineDashFor,
  saveStorage,
} from './storage.js';
import { refreshTemplatesPanel } from './templates.js';
import { switchSidePane } from './trades.js';
import { $, $$, fmtDateTime, fmtPrice, priceDp, showToast, uid } from './util.js';

// Drawing tools (canvas overlay)
// ============================================================
let drawCanvas, drawCtx;
function initDrawCanvas() {
  drawCanvas = $('draw-canvas');
  drawCtx = drawCanvas.getContext('2d');
  resizeDrawCanvas();
  // Resize observer：改成走 syncPaneChartSizes()，讓圖表尺寸由「容器實際大小」驅動。
  // 原本只重畫 draw-canvas、沒有 resize 主圖表，所以任何沒有伴隨 window resize 事件的
  // 容器變化（iOS 轉向後的延遲、網址列收合、側欄拖曳）都會留下一張比容器大的畫布。
  const ro = new ResizeObserver(() => {
    if (_syncingPanes) return; // resize 圖表不會改到 .chart-wrap，但別讓 RO 自我遞迴
    syncPaneChartSizes();
  });
  ro.observe(drawCanvas.parentElement);

  // Hook into chart pan/zoom for redraw
  chart.timeScale().subscribeVisibleTimeRangeChange(redrawDrawings);
  chart.timeScale().subscribeVisibleLogicalRangeChange(redrawDrawings);

  // Click - record drawing point
  chart.subscribeClick((param) => {
    if (!state.tool || !param.time || !param.point) return;
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price == null) return;
    handleToolClick(param.time, price);
  });

  // Crosshair - preview while drawing
  chart.subscribeCrosshairMove((param) => {
    if (!state.tool || !state.pendingPoints.length) {
      // Update default chart-overlay cursor info (preserved from original)
      return;
    }
    if (!param.time || !param.point) return;
    const price = candleSeries.coordinateToPrice(param.point.y);
    if (price == null) return;
    state.hoverPoint = { time: param.time, price: snapPrice(param.time, price) };
    redrawDrawings();
  });
}

function resizeDrawCanvas() {
  if (!drawCanvas) return;
  const rect = drawCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  drawCanvas.width = Math.floor(rect.width * dpr);
  drawCanvas.height = Math.floor(rect.height * dpr);
  drawCanvas.style.width = rect.width + 'px';
  drawCanvas.style.height = rect.height + 'px';
  drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function timeToX(time) {
  const x = chart.timeScale().timeToCoordinate(time);
  return x == null ? null : x;
}
// 時間 → 最接近的 K 棒索引（繪圖平移用：日線有週末假日缺口，
// 直接對時間戳加減會落在沒有 K 棒的時間，圖形就會變成畫不出也點不到的幽靈）
function timeToIndex(time) {
  const arr = state.candles;
  if (!arr.length) return -1;
  let lo = 0,
    hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1].time - time) <= Math.abs(arr[lo].time - time)) return lo - 1;
  return lo;
}
function priceToY(price) {
  return candleSeries.priceToCoordinate(price);
}

// 選取繪圖時的浮動操作列（顯示類型 + 刪除鈕）；redrawDrawings 每次都會同步，狀態不會漏
const DRAW_TYPE_LABEL = {
  trend: '趨勢線',
  hline: '水平線',
  rect: '矩形',
  fib: '斐波那契',
  ray: '射線',
  extline: '延伸線',
  vline: '垂直線',
  channel: '平行通道',
  ellipse: '橢圓',
  arrow: '箭頭',
  text: '文字',
  pricelabel: '價格標籤',
  measure: '測量',
};
function updateDrawSelectedBar() {
  const bar = $('draw-selected-bar');
  if (!bar) return;
  const d = state.selectedDrawingId
    ? getCurrentDrawings().find((x) => x.id === state.selectedDrawingId)
    : null;
  if (d) {
    $('dsb-label').textContent = DRAW_TYPE_LABEL[d.type] || '繪圖';
    bar.style.display = 'flex';
  } else {
    bar.style.display = 'none';
  }
}

function redrawDrawings() {
  if (!drawCtx || !drawCanvas) return;
  updateDrawSelectedBar();
  const w = drawCanvas.parentElement.clientWidth;
  const h = drawCanvas.parentElement.clientHeight;
  drawCtx.clearRect(0, 0, w, h);
  drawIndicatorCanvas(); // 一目雲帶 + SAR 點（最底層）
  drawOpenPositionZones(); // 持倉止盈/止損紅綠區
  if (!state.drawingsHidden) {
    for (const d of getCurrentDrawings()) {
      drawShape(d, false);
    }
  }
  // Preview while drawing - use active template style for the tool
  if (!state.drawingsHidden && state.tool && state.pendingPoints.length && state.hoverPoint) {
    const previewShape = {
      type: state.tool,
      points: [...state.pendingPoints, state.hoverPoint],
      style: getActiveTplStyle(state.tool),
    };
    drawShape(previewShape, true);
  }
  drawPosToolOverlay(); // 圖表下單部位工具（最上層）
}

// ---- 指標 canvas 疊加：一目雲帶 + SAR ----
function drawIndicatorCanvas() {
  if (!candleSeries) return;
  if (ichimokuCloudCache) {
    const { a, b } = ichimokuCloudCache;
    drawCtx.save();
    for (let i = 0; i < a.length - 1; i++) {
      const t1 = a[i].time,
        t2 = a[i + 1].time;
      const b1 = b.get(t1),
        b2 = b.get(t2);
      if (b1 == null || b2 == null) continue;
      const x1 = timeToX(t1),
        x2 = timeToX(t2);
      if (x1 == null || x2 == null) continue;
      const ya1 = priceToY(a[i].value),
        ya2 = priceToY(a[i + 1].value);
      const yb1 = priceToY(b1),
        yb2 = priceToY(b2);
      if (ya1 == null || ya2 == null || yb1 == null || yb2 == null) continue;
      const bull = ya1 + ya2 <= yb1 + yb2; // 先行A 在上 → 多方雲
      drawCtx.fillStyle = bull ? 'rgba(8,153,129,0.10)' : 'rgba(242,54,69,0.10)';
      drawCtx.beginPath();
      drawCtx.moveTo(x1, ya1);
      drawCtx.lineTo(x2, ya2);
      drawCtx.lineTo(x2, yb2);
      drawCtx.lineTo(x1, yb1);
      drawCtx.closePath();
      drawCtx.fill();
    }
    drawCtx.restore();
  }
  if (sarCache) {
    drawCtx.save();
    for (const pt of sarCache) {
      const x = timeToX(pt.time);
      if (x == null) continue;
      const y = priceToY(pt.value);
      if (y == null) continue;
      drawCtx.fillStyle = pt.up ? '#089981' : '#f23645';
      drawCtx.beginPath();
      drawCtx.arc(x, y, 1.8, 0, Math.PI * 2);
      drawCtx.fill();
    }
    drawCtx.restore();
  }
}

// ---- 持倉止盈/止損區塊（TV 式紅綠色帶）----
function drawOpenPositionZones() {
  if (!candleSeries) return;
  const w = drawCanvas.parentElement.clientWidth;
  for (const p of state.positions) {
    if (p.status !== 'open') continue;
    if (p.symbol !== state.symbol || p.timeframe !== state.timeframe || !inScope(p)) continue;
    // 停損/停利選填：只畫有設定那一側的色帶
    const yE = priceToY(p.entryPrice);
    if (yE == null) continue;
    const yT = p.takeProfit != null ? priceToY(p.takeProfit) : null;
    const yS = p.stopLoss != null ? priceToY(p.stopLoss) : null;
    let x0 = timeToX(p.entryTime);
    if (x0 == null || x0 < 0) x0 = 0;
    drawCtx.save();
    if (yT != null) {
      drawCtx.fillStyle = 'rgba(8,153,129,0.10)';
      drawCtx.fillRect(x0, Math.min(yE, yT), w - x0, Math.abs(yT - yE));
    }
    if (yS != null) {
      drawCtx.fillStyle = 'rgba(242,54,69,0.10)';
      drawCtx.fillRect(x0, Math.min(yE, yS), w - x0, Math.abs(yS - yE));
    }
    drawCtx.restore();
  }
}

// ---- TV 式圖表下單部位工具 ----
function drawPosToolOverlay() {
  const pt = state.posTool;
  if (!pt || !candleSeries) return;
  const w = drawCanvas.parentElement.clientWidth;
  const yE = priceToY(pt.entry),
    yT = priceToY(pt.tp),
    yS = priceToY(pt.sl);
  if (yE == null || yT == null || yS == null) return;
  const cur = state.candles[state.cursorIndex];
  let x0 = cur ? timeToX(cur.time) : null;
  if (x0 == null) x0 = Math.floor(w * 0.55);
  x0 = Math.max(0, Math.min(x0, w - 60));
  const { size, riskAmount } = calcOrderSize(
    pt.entry,
    pt.sl,
    +$('order-risk').value || 1,
    state.settings.balance,
  );
  const pv = getPointValue(state.symbol);
  const gain = Math.abs(pt.tp - pt.entry) * pv * size;
  const dist = Math.abs(pt.entry - pt.sl);
  const rr = dist > 0 ? Math.abs(pt.tp - pt.entry) / dist : 0;
  drawCtx.save();
  drawCtx.fillStyle = 'rgba(8,153,129,0.18)';
  drawCtx.fillRect(x0, Math.min(yE, yT), w - x0, Math.abs(yT - yE));
  drawCtx.fillStyle = 'rgba(242,54,69,0.18)';
  drawCtx.fillRect(x0, Math.min(yE, yS), w - x0, Math.abs(yS - yE));
  const line = (y, color, dash) => {
    drawCtx.strokeStyle = color;
    drawCtx.lineWidth = 1.5;
    drawCtx.setLineDash(dash || []);
    drawCtx.beginPath();
    drawCtx.moveTo(x0, y);
    drawCtx.lineTo(w, y);
    drawCtx.stroke();
    drawCtx.setLineDash([]);
  };
  line(yT, '#089981');
  line(yS, '#f23645');
  line(yE, '#b2b5be', [5, 4]);
  drawLabelChip(
    `目標 ${fmtPrice(pt.tp)}  ${fmtMoneySigned(gain)}  (${rr.toFixed(2)}R)`,
    x0 + 8,
    yT - 10,
    '#089981',
    'left',
  );
  drawLabelChip(
    `${pt.side === 'long' ? '多' : '空'}單進場 ${fmtPrice(pt.entry)} ⇕`,
    x0 + 8,
    yE - 10,
    '#b2b5be',
    'left',
  );
  drawLabelChip(
    `停損 ${fmtPrice(pt.sl)}  ${fmtMoneySigned(-riskAmount)}`,
    x0 + 8,
    yS + 12,
    '#f23645',
    'left',
  );
  drawCtx.restore();
}

function posToolHitAtY(y) {
  const pt = state.posTool;
  if (!pt || !candleSeries) return null;
  const HIT = 6;
  const yT = priceToY(pt.tp),
    yS = priceToY(pt.sl),
    yE = priceToY(pt.entry);
  if (yT != null && Math.abs(y - yT) <= HIT) return 'tp';
  if (yS != null && Math.abs(y - yS) <= HIT) return 'sl';
  if (yE != null && Math.abs(y - yE) <= HIT) return 'entry';
  return null;
}

function setPosTool(side) {
  const c = state.candles[state.cursorIndex];
  if (!c) {
    showToast('請先載入資料', 'error');
    return;
  }
  if (state.posTool && state.posTool.side === side) {
    clearPosTool();
    return;
  } // 再按一次關閉
  const dp = priceDp(c.close);
  const r = (v) => +v.toFixed(dp);
  const dir = side === 'long' ? 1 : -1;
  state.posTool = {
    side,
    entry: r(c.close),
    sl: r(c.close * (1 - 0.005 * dir)),
    tp: r(c.close * (1 + 0.01 * dir)),
  };
  setTool(''); // 關閉畫圖工具避免點擊衝突
  setOrderSide(side);
  syncPosToolToForm();
  updatePosToolButtons();
  redrawDrawings();
  switchSidePane('order');
  showToast(
    `🎯 ${side === 'long' ? '多' : '空'}單部位工具：拖曳三條線調整，於下單面板送出`,
    'success',
  );
}
function clearPosTool() {
  if (!state.posTool) return;
  state.posTool = null;
  updatePosToolButtons();
  redrawDrawings();
}
function updatePosToolButtons() {
  $$('.draw-toolbar button[data-postool]').forEach((b) =>
    b.classList.toggle('active', !!state.posTool && state.posTool.side === b.dataset.postool),
  );
}
function syncPosToolToForm() {
  const pt = state.posTool;
  if (!pt) return;
  const set = (id, v) => {
    const el = $(id);
    el.value = v;
    el.dataset.touched = '1';
  };
  set('order-entry', pt.entry);
  set('order-sl', pt.sl);
  set('order-tp', pt.tp);
  updateOrderSummary();
}
// 表單 → 工具（使用者手動改欄位時）
function syncFormToPosTool() {
  const pt = state.posTool;
  if (!pt) return;
  const e = +$('order-entry').value,
    s = +$('order-sl').value,
    t = +$('order-tp').value;
  if (e > 0) pt.entry = e;
  if (s > 0) pt.sl = s;
  if (t > 0) pt.tp = t;
  redrawDrawings();
}

function onPosToolDragMove(e) {
  if (!store.posToolDrag || !state.posTool) return;
  const rect = $('chart').getBoundingClientRect();
  let price = candleSeries.coordinateToPrice(e.clientY - rect.top);
  if (price == null) return;
  const pt = state.posTool;
  const dp = priceDp(pt.entry || price);
  const f = Math.pow(10, dp);
  const eps = 1 / f;
  price = Math.round(price * f) / f;
  if (store.posToolDrag === 'entry') {
    const delta = price - pt.entry; // 拖進場線 → 整組平移（TV 行為）
    pt.entry = +(pt.entry + delta).toFixed(dp);
    pt.sl = +(pt.sl + delta).toFixed(dp);
    pt.tp = +(pt.tp + delta).toFixed(dp);
  } else if (store.posToolDrag === 'tp') {
    pt.tp = pt.side === 'long' ? Math.max(price, pt.entry + eps) : Math.min(price, pt.entry - eps);
  } else {
    pt.sl = pt.side === 'long' ? Math.min(price, pt.entry - eps) : Math.max(price, pt.entry + eps);
  }
  syncPosToolToForm();
  redrawDrawings();
}
function onPosToolDragEnd() {
  store.posToolDrag = null;
  document.body.style.cursor = '';
  document.removeEventListener('mousemove', onPosToolDragMove);
  document.removeEventListener('mouseup', onPosToolDragEnd);
}

function drawShape(d, isPreview) {
  const style = d.style || {
    color: d.color || '#3b82f6',
    lineWidth: 2,
    lineStyle: 0,
    label: '',
  };
  const color = style.color;
  const selected = d.id && d.id === state.selectedDrawingId;
  drawCtx.save();
  drawCtx.globalAlpha = isPreview ? 0.6 : 1;
  if (d.type === 'trend') drawTrend(d, style, selected);
  else if (d.type === 'hline') drawHLine(d, style, selected);
  else if (d.type === 'rect') drawRect(d, style, selected);
  else if (d.type === 'fib') drawFib(d, style, selected);
  else if (d.type === 'ray') drawRayLine(d, style, selected, false);
  else if (d.type === 'extline') drawRayLine(d, style, selected, true);
  else if (d.type === 'vline') drawVLine(d, style, selected);
  else if (d.type === 'channel') drawChannel(d, style, selected);
  else if (d.type === 'ellipse') drawEllipseShape(d, style, selected);
  else if (d.type === 'arrow') drawArrowShape(d, style, selected);
  else if (d.type === 'text') drawTextShape(d, style, selected);
  else if (d.type === 'pricelabel') drawPriceLabel(d, style, selected);
  else if (d.type === 'measure') drawMeasure(d, style, selected);
  if (selected && !isPreview) drawSelectionAnchors(d);
  drawCtx.restore();
}

// 線段沿方向延伸（射線/延伸線用）
function extendSegment(x1, y1, x2, y2, extendStart, extendEnd) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) return [x1, y1, x2, y2];
  const ux = dx / len,
    uy = dy / len;
  const E = 10000;
  return [
    extendStart ? x1 - ux * E : x1,
    extendStart ? y1 - uy * E : y1,
    extendEnd ? x2 + ux * E : x2,
    extendEnd ? y2 + uy * E : y2,
  ];
}

function drawRayLine(d, style, selected, bothWays) {
  if (d.points.length < 2) return;
  const x1 = timeToX(d.points[0].time),
    y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time),
    y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const [ex1, ey1, ex2, ey2] = extendSegment(x1, y1, x2, y2, bothWays, true);
  drawCtx.strokeStyle = style.color;
  drawCtx.lineWidth = (style.lineWidth || 2) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle));
  drawCtx.beginPath();
  drawCtx.moveTo(ex1, ey1);
  drawCtx.lineTo(ex2, ey2);
  drawCtx.stroke();
  drawCtx.setLineDash([]);
  if (!selected) {
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      drawCtx.fillStyle = style.color;
      drawCtx.beginPath();
      drawCtx.arc(x, y, 3, 0, Math.PI * 2);
      drawCtx.fill();
    }
  }
  if (style.label) drawLabelChip(style.label, (x1 + x2) / 2, (y1 + y2) / 2 - 10, style.color);
}

function drawVLine(d, style, selected) {
  const x = timeToX(d.points[0].time);
  if (x == null) return;
  const h = drawCanvas.parentElement.clientHeight;
  drawCtx.strokeStyle = style.color;
  drawCtx.lineWidth = (style.lineWidth || 1) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle == null ? 2 : style.lineStyle));
  drawCtx.beginPath();
  drawCtx.moveTo(x, 0);
  drawCtx.lineTo(x, h);
  drawCtx.stroke();
  drawCtx.setLineDash([]);
  if (!state.blind) {
    drawLabelChip(fmtDateTime(d.points[0].time, state.timeframe), x, h - 12, style.color);
  }
  if (style.label) drawLabelChip(style.label, x, 12, style.color);
}

function drawChannel(d, style, selected) {
  if (d.points.length < 2) return;
  const x1 = timeToX(d.points[0].time),
    y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time),
    y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const color = style.color;
  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = (style.lineWidth || 1.5) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle));
  drawCtx.beginPath();
  drawCtx.moveTo(x1, y1);
  drawCtx.lineTo(x2, y2);
  drawCtx.stroke();
  if (d.points.length >= 3) {
    const x3 = timeToX(d.points[2].time),
      y3 = priceToY(d.points[2].price);
    if (x3 != null && y3 != null) {
      // 垂直位移的平行線（TV 行為）
      const dyOff = x2 === x1 ? y3 - y1 : y3 - (y1 + ((y2 - y1) * (x3 - x1)) / (x2 - x1));
      drawCtx.beginPath();
      drawCtx.moveTo(x1, y1 + dyOff);
      drawCtx.lineTo(x2, y2 + dyOff);
      drawCtx.stroke();
      drawCtx.setLineDash([]);
      drawCtx.fillStyle = color + '18';
      drawCtx.beginPath();
      drawCtx.moveTo(x1, y1);
      drawCtx.lineTo(x2, y2);
      drawCtx.lineTo(x2, y2 + dyOff);
      drawCtx.lineTo(x1, y1 + dyOff);
      drawCtx.closePath();
      drawCtx.fill();
      // 中線（虛線）
      drawCtx.strokeStyle = color;
      drawCtx.setLineDash([4, 4]);
      drawCtx.globalAlpha *= 0.6;
      drawCtx.beginPath();
      drawCtx.moveTo(x1, y1 + dyOff / 2);
      drawCtx.lineTo(x2, y2 + dyOff / 2);
      drawCtx.stroke();
      drawCtx.globalAlpha /= 0.6;
    }
  }
  drawCtx.setLineDash([]);
  if (style.label) drawLabelChip(style.label, (x1 + x2) / 2, (y1 + y2) / 2 - 10, color);
}

function drawEllipseShape(d, style, selected) {
  if (d.points.length < 2) return;
  const x1 = timeToX(d.points[0].time),
    y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time),
    y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const cx = (x1 + x2) / 2,
    cy = (y1 + y2) / 2;
  const rx = Math.max(2, Math.abs(x2 - x1) / 2),
    ry = Math.max(2, Math.abs(y2 - y1) / 2);
  drawCtx.fillStyle = style.color + '22';
  drawCtx.strokeStyle = style.color;
  drawCtx.lineWidth = (style.lineWidth || 1.5) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle));
  drawCtx.beginPath();
  drawCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  drawCtx.fill();
  drawCtx.stroke();
  drawCtx.setLineDash([]);
  if (style.label) drawLabelChip(style.label, cx, cy - ry - 10, style.color);
}

function drawArrowShape(d, style, selected) {
  if (d.points.length < 2) return;
  const x1 = timeToX(d.points[0].time),
    y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time),
    y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  drawCtx.strokeStyle = style.color;
  drawCtx.fillStyle = style.color;
  drawCtx.lineWidth = (style.lineWidth || 2) + (selected ? 1 : 0);
  drawCtx.setLineDash([]);
  drawCtx.beginPath();
  drawCtx.moveTo(x1, y1);
  drawCtx.lineTo(x2, y2);
  drawCtx.stroke();
  // 箭頭頭部
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hl = 10 + (style.lineWidth || 2) * 2;
  drawCtx.beginPath();
  drawCtx.moveTo(x2, y2);
  drawCtx.lineTo(x2 - hl * Math.cos(ang - 0.42), y2 - hl * Math.sin(ang - 0.42));
  drawCtx.lineTo(x2 - hl * Math.cos(ang + 0.42), y2 - hl * Math.sin(ang + 0.42));
  drawCtx.closePath();
  drawCtx.fill();
  if (style.label) drawLabelChip(style.label, (x1 + x2) / 2, (y1 + y2) / 2 - 10, style.color);
}

function drawTextShape(d, style, selected) {
  const x = timeToX(d.points[0].time),
    y = priceToY(d.points[0].price);
  if (x == null || y == null) return;
  const text = d.text || style.label || '文字';
  drawCtx.font = '600 13px -apple-system, "PingFang TC", sans-serif';
  drawCtx.fillStyle = style.color;
  drawCtx.textBaseline = 'middle';
  drawCtx.fillText(text, x, y);
  if (selected) {
    const tw = drawCtx.measureText(text).width;
    drawCtx.strokeStyle = style.color;
    drawCtx.lineWidth = 1;
    drawCtx.setLineDash([3, 3]);
    drawCtx.strokeRect(x - 4, y - 11, tw + 8, 22);
    drawCtx.setLineDash([]);
  }
}

function drawPriceLabel(d, style, selected) {
  const x = timeToX(d.points[0].time),
    y = priceToY(d.points[0].price);
  if (x == null || y == null) return;
  // 指向點的小三角 + 價格 chip
  drawCtx.fillStyle = style.color;
  drawCtx.beginPath();
  drawCtx.moveTo(x, y);
  drawCtx.lineTo(x + 8, y - 5);
  drawCtx.lineTo(x + 8, y + 5);
  drawCtx.closePath();
  drawCtx.fill();
  drawLabelChip(
    fmtPrice(d.points[0].price) + (style.label ? ' ' + style.label : ''),
    x + 8,
    y,
    style.color,
    'left',
  );
  if (selected) {
    drawCtx.strokeStyle = style.color;
    drawCtx.lineWidth = 1;
    drawCtx.beginPath();
    drawCtx.arc(x, y, 6, 0, Math.PI * 2);
    drawCtx.stroke();
  }
}

function drawMeasure(d, style, selected) {
  if (d.points.length < 2) return;
  const p1 = d.points[0],
    p2 = d.points[1];
  const x1 = timeToX(p1.time),
    y1 = priceToY(p1.price);
  const x2 = timeToX(p2.time),
    y2 = priceToY(p2.price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const dPrice = p2.price - p1.price;
  const pct = p1.price ? (dPrice / p1.price) * 100 : 0;
  let bars = 0;
  for (const c of state.candles) {
    if (c.time > Math.min(p1.time, p2.time) && c.time <= Math.max(p1.time, p2.time)) bars++;
  }
  const upMove = dPrice >= 0;
  const boxColor = upMove ? 'rgba(8,153,129,0.14)' : 'rgba(242,54,69,0.14)';
  const lineColor = upMove ? '#089981' : '#f23645';
  const x = Math.min(x1, x2),
    y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1),
    h = Math.abs(y2 - y1);
  drawCtx.fillStyle = boxColor;
  drawCtx.strokeStyle = lineColor;
  drawCtx.lineWidth = 1 + (selected ? 1 : 0);
  drawCtx.fillRect(x, y, w, h);
  drawCtx.strokeRect(x, y, w, h);
  // 中央資訊卡
  const lines = [
    `${dPrice >= 0 ? '+' : ''}${fmtPrice(dPrice)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
    `${bars} 根 K 棒`,
  ];
  drawCtx.font = '11px -apple-system, sans-serif';
  const cw = Math.max(...lines.map((t) => drawCtx.measureText(t).width)) + 16;
  const chH = 34;
  const bx = x + w / 2 - cw / 2,
    by = y + h / 2 - chH / 2;
  drawCtx.fillStyle = lineColor;
  drawCtx.fillRect(bx, by, cw, chH);
  drawCtx.fillStyle = '#fff';
  drawCtx.textBaseline = 'middle';
  lines.forEach((t, i) => {
    const tw2 = drawCtx.measureText(t).width;
    drawCtx.fillText(t, bx + (cw - tw2) / 2, by + 10 + i * 15);
  });
}

function drawLabelChip(text, x, y, color, align) {
  if (!text) return;
  drawCtx.save();
  drawCtx.font = '11px -apple-system, sans-serif';
  const padX = 5,
    padY = 2;
  const tw = drawCtx.measureText(text).width;
  const w = tw + padX * 2;
  const h = 16;
  let bx;
  if (align === 'right') bx = x - w;
  else if (align === 'left') bx = x;
  else bx = x - w / 2;
  drawCtx.fillStyle = color;
  drawCtx.fillRect(bx, y - h / 2, w, h);
  drawCtx.fillStyle = '#131722';
  drawCtx.textBaseline = 'middle';
  drawCtx.fillText(text, bx + padX, y);
  drawCtx.restore();
}

function drawSelectionAnchors(d) {
  for (const point of d.points) {
    const x = timeToX(point.time);
    const y = priceToY(point.price);
    if (x == null || y == null) continue;
    drawCtx.save();
    drawCtx.fillStyle = '#fff';
    drawCtx.strokeStyle = '#131722';
    drawCtx.lineWidth = 2;
    drawCtx.beginPath();
    drawCtx.arc(x, y, 6, 0, Math.PI * 2);
    drawCtx.fill();
    drawCtx.stroke();
    drawCtx.restore();
  }
}

// ---- Hit testing ----
const HIT_PX_LINE = 5;
const HIT_PX_ANCHOR = 8;

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTestDrawing(d, px, py) {
  // --- 單點類型 ---
  if (d.type === 'hline') {
    const y = priceToY(d.points[0].price);
    if (y == null) return null;
    return Math.abs(py - y) <= HIT_PX_LINE ? { mode: 'move' } : null;
  }
  if (d.type === 'vline') {
    const x = timeToX(d.points[0].time);
    if (x == null) return null;
    return Math.abs(px - x) <= HIT_PX_LINE ? { mode: 'move' } : null;
  }
  if (d.type === 'text') {
    const x = timeToX(d.points[0].time),
      y = priceToY(d.points[0].price);
    if (x == null || y == null) return null;
    drawCtx.font = '600 13px -apple-system, "PingFang TC", sans-serif';
    const tw = drawCtx.measureText(d.text || '文字').width;
    return px >= x - 6 && px <= x + tw + 6 && py >= y - 13 && py <= y + 13
      ? { mode: 'move' }
      : null;
  }
  if (d.type === 'pricelabel') {
    const x = timeToX(d.points[0].time),
      y = priceToY(d.points[0].price);
    if (x == null || y == null) return null;
    return px >= x - 8 && px <= x + 90 && py >= y - 12 && py <= y + 12 ? { mode: 'move' } : null;
  }

  // --- 多點類型（先測 anchor）---
  const pts = d.points.map((p) => [timeToX(p.time), priceToY(p.price)]);
  if (pts.some(([x, y]) => x == null || y == null)) return null;
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(px - pts[i][0], py - pts[i][1]) <= HIT_PX_ANCHOR)
      return { mode: 'anchor', idx: i };
  }
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[1] || pts[0];

  if (d.type === 'trend' || d.type === 'fib' || d.type === 'arrow' || d.type === 'measure') {
    if (d.type === 'measure') {
      const xL = Math.min(x1, x2),
        xR = Math.max(x1, x2);
      const yT = Math.min(y1, y2),
        yB = Math.max(y1, y2);
      if (px >= xL && px <= xR && py >= yT && py <= yB) return { mode: 'move' };
    }
    if (distanceToSegment(px, py, x1, y1, x2, y2) <= HIT_PX_LINE) return { mode: 'move' };
    return null;
  }
  if (d.type === 'ray' || d.type === 'extline') {
    const [ex1, ey1, ex2, ey2] = extendSegment(x1, y1, x2, y2, d.type === 'extline', true);
    if (distanceToSegment(px, py, ex1, ey1, ex2, ey2) <= HIT_PX_LINE) return { mode: 'move' };
    return null;
  }
  if (d.type === 'channel') {
    if (distanceToSegment(px, py, x1, y1, x2, y2) <= HIT_PX_LINE) return { mode: 'move' };
    if (pts[2]) {
      const [x3, y3] = pts[2];
      const dyOff = x2 === x1 ? y3 - y1 : y3 - (y1 + ((y2 - y1) * (x3 - x1)) / (x2 - x1));
      if (distanceToSegment(px, py, x1, y1 + dyOff, x2, y2 + dyOff) <= HIT_PX_LINE)
        return { mode: 'move' };
      // 通道內部
      const yOnBase = x2 === x1 ? y1 : y1 + ((y2 - y1) * (px - x1)) / (x2 - x1);
      const inX = px >= Math.min(x1, x2) && px <= Math.max(x1, x2);
      if (
        inX &&
        py >= Math.min(yOnBase, yOnBase + dyOff) &&
        py <= Math.max(yOnBase, yOnBase + dyOff)
      )
        return { mode: 'move' };
    }
    return null;
  }
  if (d.type === 'ellipse') {
    const cx = (x1 + x2) / 2,
      cy = (y1 + y2) / 2;
    const rx = Math.max(2, Math.abs(x2 - x1) / 2),
      ry = Math.max(2, Math.abs(y2 - y1) / 2);
    const v = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
    return v <= 1.15 ? { mode: 'move' } : null;
  }
  if (d.type === 'rect') {
    const xL = Math.min(x1, x2),
      xR = Math.max(x1, x2);
    const yT = Math.min(y1, y2),
      yB = Math.max(y1, y2);
    const onEdge =
      (Math.abs(px - xL) <= HIT_PX_LINE && py >= yT - 2 && py <= yB + 2) ||
      (Math.abs(px - xR) <= HIT_PX_LINE && py >= yT - 2 && py <= yB + 2) ||
      (Math.abs(py - yT) <= HIT_PX_LINE && px >= xL - 2 && px <= xR + 2) ||
      (Math.abs(py - yB) <= HIT_PX_LINE && px >= xL - 2 && px <= xR + 2);
    if (onEdge) return { mode: 'move' };
    if (px >= xL && px <= xR && py >= yT && py <= yB) return { mode: 'move' };
    return null;
  }
  return null;
}

function hitTestAllDrawings(px, py) {
  if (state.drawingsHidden) return null;
  const arr = getCurrentDrawings();
  for (let i = arr.length - 1; i >= 0; i--) {
    const d = arr[i];
    const hit = hitTestDrawing(d, px, py);
    if (hit) return { drawing: d, ...hit };
  }
  return null;
}

function drawTrend(d, style, selected) {
  const x1 = timeToX(d.points[0].time);
  const y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time);
  const y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const color = style.color;
  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = (style.lineWidth || 2) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle));
  drawCtx.beginPath();
  drawCtx.moveTo(x1, y1);
  drawCtx.lineTo(x2, y2);
  drawCtx.stroke();
  drawCtx.setLineDash([]);
  if (!selected) {
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      drawCtx.fillStyle = color;
      drawCtx.beginPath();
      drawCtx.arc(x, y, 3, 0, Math.PI * 2);
      drawCtx.fill();
    }
  }
  // Label at midpoint
  if (style.label) {
    const mx = (x1 + x2) / 2,
      my = (y1 + y2) / 2;
    drawLabelChip(style.label, mx, my - 10, color);
  }
}

function drawHLine(d, style, selected) {
  const y = priceToY(d.points[0].price);
  if (y == null) return;
  const w = drawCanvas.parentElement.clientWidth;
  const color = style.color;
  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = (style.lineWidth || 1) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle == null ? 2 : style.lineStyle));
  drawCtx.beginPath();
  drawCtx.moveTo(0, y);
  drawCtx.lineTo(w, y);
  drawCtx.stroke();
  drawCtx.setLineDash([]);
  // Price label (always shown at left)
  const priceText = fmtPrice(d.points[0].price);
  drawCtx.font = '11px -apple-system, sans-serif';
  const tw = drawCtx.measureText(priceText).width;
  drawCtx.fillStyle = color;
  drawCtx.fillRect(8, y - 14, tw + 8, 16);
  drawCtx.fillStyle = '#131722';
  drawCtx.fillText(priceText, 12, y - 2);
  // Custom label (on the right) if provided
  if (style.label) {
    drawLabelChip(style.label, w - 10, y - 10, color, 'right');
  }
}

function drawRect(d, style, selected) {
  const x1 = timeToX(d.points[0].time);
  const y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time);
  const y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const color = style.color;
  const x = Math.min(x1, x2),
    y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1),
    h = Math.abs(y2 - y1);
  drawCtx.fillStyle = color + '22';
  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = (style.lineWidth || 1.5) + (selected ? 1 : 0);
  drawCtx.setLineDash(lineDashFor(style.lineStyle));
  drawCtx.fillRect(x, y, w, h);
  drawCtx.strokeRect(x, y, w, h);
  drawCtx.setLineDash([]);
  if (style.label) {
    drawLabelChip(style.label, x + 6, y + 14, color, 'left');
  }
}

function drawFib(d, style, selected) {
  const x1 = timeToX(d.points[0].time);
  const y1 = priceToY(d.points[0].price);
  const x2 = timeToX(d.points[1].time);
  const y2 = priceToY(d.points[1].price);
  if (x1 == null || x2 == null || y1 == null || y2 == null) return;
  const color = style.color;
  const p1 = d.points[0].price;
  const p2 = d.points[1].price;
  const cw = drawCanvas.parentElement.clientWidth;
  const levels = [
    { lv: 0, c: '#94a3b8' },
    { lv: 0.236, c: '#fbbf24' },
    { lv: 0.382, c: '#f59e0b' },
    { lv: 0.5, c: '#089981' },
    { lv: 0.618, c: '#3b82f6' },
    { lv: 0.786, c: '#a855f7' },
    { lv: 1, c: '#94a3b8' },
  ];
  drawCtx.lineWidth = 1;
  drawCtx.font = '10px -apple-system, sans-serif';
  const xL = Math.min(x1, x2);
  const xR = Math.max(x1, x2);
  for (const { lv, c } of levels) {
    const price = p1 + (p2 - p1) * lv;
    const y = priceToY(price);
    if (y == null) continue;
    drawCtx.strokeStyle = c;
    drawCtx.beginPath();
    drawCtx.moveTo(xL, y);
    drawCtx.lineTo(cw, y); // extend to right edge
    drawCtx.stroke();
    drawCtx.fillStyle = c;
    drawCtx.fillText(`${(lv * 100).toFixed(1)}%  ${fmtPrice(price)}`, xR + 6, y - 2);
  }
  // Outer trend line connecting two anchors
  drawCtx.strokeStyle = color;
  drawCtx.lineWidth = (style.lineWidth || 1) + (selected ? 1 : 0);
  drawCtx.setLineDash([4, 3]);
  drawCtx.beginPath();
  drawCtx.moveTo(x1, y1);
  drawCtx.lineTo(x2, y2);
  drawCtx.stroke();
  drawCtx.setLineDash([]);
  if (!selected) {
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      drawCtx.fillStyle = color;
      drawCtx.beginPath();
      drawCtx.arc(x, y, 3, 0, Math.PI * 2);
      drawCtx.fill();
    }
  }
  if (style.label) {
    drawLabelChip(style.label, (x1 + x2) / 2, Math.min(y1, y2) - 12, color);
  }
}

// ---- Tool actions ----
function setTool(tool) {
  state.tool = tool;
  resetPendingPoints();
  if (tool) state.selectedDrawingId = null;
  $$('.draw-toolbar button[data-tool]').forEach((b) =>
    b.classList.toggle('active', (b.dataset.tool || '') === (tool || '')),
  );
  if (tool) drawCanvas.classList.add('active');
  else drawCanvas.classList.remove('active');
  redrawDrawings();
  if (typeof refreshTemplatesPanel === 'function') refreshTemplatesPanel();
}

// 磁鐵：把點擊價吸附到該 K 棒最近的 OHLC（8px 內）
function snapPrice(time, price) {
  if (!state.magnet) return price;
  const c = state.candles.find((x) => x.time === time);
  if (!c) return price;
  const py = priceToY(price);
  if (py == null) return price;
  let best = price,
    bestDist = 8;
  for (const cand of [c.open, c.high, c.low, c.close]) {
    const cy = priceToY(cand);
    if (cy == null) continue;
    const dist = Math.abs(cy - py);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}

function resetPendingPoints() {
  state.pendingPoints = [];
  state.firstPoint = null;
  state.hoverPoint = null;
}

function handleToolClick(time, price) {
  const t = state.tool;
  price = snapPrice(time, price);
  const need = TOOL_POINTS[t] || 2;
  state.pendingPoints.push({ time, price });
  state.firstPoint = state.pendingPoints[0];
  if (state.pendingPoints.length < need) {
    showToast(`再點 ${need - state.pendingPoints.length} 點完成`, 'success');
    redrawDrawings();
    return;
  }
  const d = { type: t, points: [...state.pendingPoints], style: getActiveTplStyle(t) };
  if (t === 'text') {
    const txt = prompt('輸入文字：');
    if (!txt || !txt.trim()) {
      resetPendingPoints();
      redrawDrawings();
      return;
    }
    d.text = txt.trim();
  }
  addDrawing(d);
  resetPendingPoints();
}

function addDrawing(d) {
  d.id = uid();
  d.createdAt = Date.now();
  getCurrentDrawings().push(d);
  saveStorage();
  redrawDrawings();
}

function undoLastDrawing() {
  const arr = getCurrentDrawings();
  if (!arr.length) {
    showToast('沒有可復原的畫線', 'error');
    return;
  }
  arr.pop();
  saveStorage();
  redrawDrawings();
  showToast('已復原', 'success');
}

function clearAllDrawings() {
  const arr = getCurrentDrawings();
  if (!arr.length) return;
  // 用 symLabel（盲測中顯示「❓ 盲測標的」）＋清 getCurrentDrawings 的同一把 key，
  // 否則盲測時會在確認視窗印出答案，而且清掉的是該標的平時的畫線
  if (
    !confirm(`清除所有畫線（${symLabel(state.symbol)} ${state.timeframe} 共 ${arr.length} 筆）？`)
  )
    return;
  state.drawings[drawingsKey()] = [];
  saveStorage();
  redrawDrawings();
  showToast('已清除', 'success');
}

function toggleTimeAxis() {
  if (state.blind) {
    showToast('盲測中時間軸保持隱藏', 'error');
    return;
  }
  state.timeAxisVisible = !state.timeAxisVisible;
  chart.timeScale().applyOptions({ visible: state.timeAxisVisible });
  $('btn-toggle-time').classList.toggle('active', !state.timeAxisVisible);
  setTimeout(redrawDrawings, 50);
}

function redrawPositionLines() {
  if (!candleSeries) return;
  // Remove old（切換圖表類型後舊線已隨舊 series 銷毀，容錯處理）
  store.posLines.forEach((l) => {
    try {
      candleSeries.removePriceLine(l);
    } catch {}
  });
  store.posLines = [];
  posLineMap.clear();
  // Open positions for current symbol/tf (盲測 scope 過濾；含未成交掛單)
  const open = state.positions.filter(
    (p) =>
      (p.status === 'open' || p.status === 'pending') &&
      p.symbol === state.symbol &&
      p.timeframe === state.timeframe &&
      inScope(p),
  );
  open.forEach((p) => {
    const pending = p.status === 'pending';
    const color = p.side === 'long' ? '#089981' : '#f23645';
    const labelSide = p.side === 'long' ? 'L' : 'S';
    const entryLine = candleSeries.createPriceLine({
      price: p.entryPrice,
      color: pending ? '#b2b5be' : color,
      lineWidth: 1,
      lineStyle: pending ? 2 : 0,
      title: pending
        ? `⏳ ${labelSide} 掛單 ${fmtPrice(p.entryPrice)}`
        : `${labelSide} 進場 ${fmtPrice(p.entryPrice)}`,
    });
    // 停損/停利選填：只畫有設定的線
    let slLine = null,
      tpLine = null;
    if (p.stopLoss != null) {
      slLine = candleSeries.createPriceLine({
        price: p.stopLoss,
        color: '#f77c80',
        lineWidth: 2,
        lineStyle: 2,
        title: slLineTitle(p, p.stopLoss, false),
      });
    }
    if (p.takeProfit != null) {
      tpLine = candleSeries.createPriceLine({
        price: p.takeProfit,
        color: '#26a69a',
        lineWidth: 2,
        lineStyle: 2,
        title: tpLineTitle(p, p.takeProfit, false),
      });
    }
    store.posLines.push(entryLine);
    if (slLine) store.posLines.push(slLine);
    if (tpLine) store.posLines.push(tpLine);
    posLineMap.set(p.id, { entry: entryLine, sl: slLine, tp: tpLine });
  });
}

// ============================================================

export {
  clearAllDrawings,
  clearPosTool,
  hitTestAllDrawings,
  initDrawCanvas,
  onPosToolDragEnd,
  onPosToolDragMove,
  posToolHitAtY,
  redrawDrawings,
  redrawPositionLines,
  resetPendingPoints,
  resizeDrawCanvas,
  setPosTool,
  setTool,
  syncFormToPosTool,
  timeToIndex,
  toggleTimeAxis,
  undoLastDrawing,
  updatePosToolButtons,
};
