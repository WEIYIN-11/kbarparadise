import {
  candleSeries,
  chart,
  fmtMoneySigned,
  pnlAtPrice,
  posLineMap,
  slLineTitle,
  tpLineTitle,
} from './chart.js';
import { inScope, store } from './constants.js';
import {
  hitTestAllDrawings,
  onPosToolDragEnd,
  onPosToolDragMove,
  posToolHitAtY,
  redrawDrawings,
  redrawPositionLines,
  timeToIndex,
} from './drawings.js';
import { renderPositions } from './orders.js';
import { state } from './state.js';
import { getCurrentDrawings, saveStorage } from './storage.js';
import { refreshTemplatesPanel } from './templates.js';
import { updateHotStats } from './trades.js';
import { $, $$, fmtPrice, priceDp, showToast } from './util.js';

// Drag SL/TP lines
// ============================================================
const DRAG_HIT_PX = 6;
let dragState = null; // { posId, type:'sl'|'tp', priceLine, originalPrice }

function findDraggableLineAtY(y) {
  if (state.tool) return null; // disabled in drawing mode
  for (const p of state.positions) {
    if (p.status !== 'open' && p.status !== 'pending') continue;
    if (p.symbol !== state.symbol || p.timeframe !== state.timeframe || !inScope(p)) continue;
    // 掛單的進場線可拖曳：調整掛單價，SL/TP 整組平移（已成交的成本線固定不可拖）
    if (p.status === 'pending') {
      const eY = candleSeries.priceToCoordinate(p.entryPrice);
      if (eY != null && Math.abs(y - eY) <= DRAG_HIT_PX) {
        return { pos: p, type: 'pentry' };
      }
    }
    if (p.stopLoss != null) {
      const slY = candleSeries.priceToCoordinate(p.stopLoss);
      if (slY != null && Math.abs(y - slY) <= DRAG_HIT_PX) {
        return { pos: p, type: 'sl' };
      }
    }
    if (p.takeProfit != null) {
      const tpY = candleSeries.priceToCoordinate(p.takeProfit);
      if (tpY != null && Math.abs(y - tpY) <= DRAG_HIT_PX) {
        return { pos: p, type: 'tp' };
      }
    }
    // 已成交持倉的成本線：抓住往上/往下拖即可設定停利/停損（放開的位置決定是哪一條）
    if (p.status === 'open') {
      const eY = candleSeries.priceToCoordinate(p.entryPrice);
      if (eY != null && Math.abs(y - eY) <= DRAG_HIT_PX) {
        return { pos: p, type: 'entryset' };
      }
    }
  }
  return null;
}

function onDragMove(e) {
  if (!dragState) return;
  const chartEl = $('chart');
  const rect = chartEl.getBoundingClientRect();
  const y = e.clientY - rect.top;
  let newPrice = candleSeries.coordinateToPrice(y);
  if (newPrice == null) return;
  const p = state.positions.find((x) => x.id === dragState.posId);
  // 標的守衛：拖曳途中若切換了標的/週期，這裡的價格屬於「新標的」，
  // 寫進舊部位會產生天文數字的假損益——直接中止本次拖曳
  if (!p || p.symbol !== state.symbol || p.timeframe !== state.timeframe) {
    cancelLineDrag();
    return;
  }
  // Clamp: SL/TP must stay on the correct side of the CURRENT price
  // (otherwise the order would already be triggered).
  // SL above current = already stopped out (long); TP below current = already filled (long).
  // 掛單（pending）以掛單價為基準，而非現價
  const curBar = state.candles[state.cursorIndex];
  const refPrice = p.status === 'pending' ? p.entryPrice : curBar ? curBar.close : p.entryPrice;
  const dp = priceDp(refPrice);
  const eps = Math.pow(10, -dp);
  const f = Math.pow(10, dp);
  // 拖成本線設定停損/停利：游標在獲利側→停利、虧損側→停損（虛線即時預覽價位與金額）
  if (dragState.type === 'entryset') {
    newPrice = Math.round(newPrice * f) / f;
    const profitSide = p.side === 'long' ? newPrice > p.entryPrice : newPrice < p.entryPrice;
    dragState.setTarget = profitSide ? 'tp' : 'sl';
    dragState.setPrice = newPrice;
    if (dragState.tempLine) {
      dragState.tempLine.applyOptions({
        price: newPrice,
        color: profitSide ? '#26a69a' : '#f77c80',
        title: `${profitSide ? '🎯 設停利' : '🔻 設停損'} ${fmtPrice(newPrice)}  ${fmtMoneySigned(pnlAtPrice(p, newPrice))}`,
      });
    }
    return;
  }
  // 拖掛單進場線：整組平移（SL/TP 跟著移動，距離不變）
  if (dragState.type === 'pentry') {
    newPrice = Math.round(newPrice * f) / f;
    const delta = newPrice - p.entryPrice;
    if (!delta) return;
    p.entryPrice = +(p.entryPrice + delta).toFixed(dp);
    if (p.stopLoss != null) p.stopLoss = +(p.stopLoss + delta).toFixed(dp);
    if (p.takeProfit != null) p.takeProfit = +(p.takeProfit + delta).toFixed(dp);
    const lines = posLineMap.get(p.id);
    if (lines) {
      lines.entry.applyOptions({
        price: p.entryPrice,
        title: `⏳ ${p.side === 'long' ? 'L' : 'S'} 掛單 ${fmtPrice(p.entryPrice)} …`,
      });
      if (lines.sl)
        lines.sl.applyOptions({ price: p.stopLoss, title: slLineTitle(p, p.stopLoss, true) });
      if (lines.tp)
        lines.tp.applyOptions({
          price: p.takeProfit,
          title: tpLineTitle(p, p.takeProfit, true),
        });
    }
    renderPositions();
    return;
  }
  if (p.side === 'long') {
    if (dragState.type === 'sl') newPrice = Math.min(newPrice, refPrice - eps);
    else newPrice = Math.max(newPrice, refPrice + eps);
  } else {
    if (dragState.type === 'sl') newPrice = Math.max(newPrice, refPrice + eps);
    else newPrice = Math.min(newPrice, refPrice - eps);
  }
  newPrice = Math.round(newPrice * f) / f;
  if (dragState.type === 'sl') {
    p.stopLoss = newPrice;
    dragState.priceLine.applyOptions({
      price: newPrice,
      title: slLineTitle(p, newPrice, true),
    });
  } else {
    p.takeProfit = newPrice;
    dragState.priceLine.applyOptions({
      price: newPrice,
      title: tpLineTitle(p, newPrice, true),
    });
  }
  renderPositions();
  updateHotStats();
}

// 手勢被系統中斷（touchcancel）：還原到拖曳前的狀態，不套用任何變更
function cancelLineDrag() {
  if (!dragState) return;
  const p = state.positions.find((x) => x.id === dragState.posId);
  if (dragState.tempLine) {
    try {
      candleSeries.removePriceLine(dragState.tempLine);
    } catch {}
  }
  if (p) {
    if (dragState.type === 'pentry') p.entryPrice = dragState.originalPrice;
    p.stopLoss = dragState.origSl ?? p.stopLoss;
    p.takeProfit = dragState.origTp ?? p.takeProfit;
    redrawPositionLines();
    renderPositions();
    updateHotStats();
  }
  document.body.style.cursor = '';
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  dragState = null;
}

function onDragEnd() {
  if (!dragState) return;
  const p = state.positions.find((x) => x.id === dragState.posId);
  // 同 onDragMove 的標的守衛：切換標的後放開滑鼠不得套用
  if (p && (p.symbol !== state.symbol || p.timeframe !== state.timeframe)) {
    cancelLineDrag();
    return;
  }
  // 成本線拖曳設定：移除預覽虛線，把放開的價位寫進停損或停利
  if (dragState.type === 'entryset') {
    if (dragState.tempLine) {
      try {
        candleSeries.removePriceLine(dragState.tempLine);
      } catch {}
    }
    if (p && dragState.setTarget && dragState.setPrice != null) {
      const curBar = state.candles[state.cursorIndex];
      const ref = curBar ? curBar.close : p.entryPrice;
      const dp = priceDp(ref);
      const eps = Math.pow(10, -dp);
      let price = dragState.setPrice;
      // 與拖曳 SL/TP 相同的保護：必須在現價的正確側，否則掛上去當根就觸發
      if (p.side === 'long')
        price =
          dragState.setTarget === 'sl' ? Math.min(price, ref - eps) : Math.max(price, ref + eps);
      else
        price =
          dragState.setTarget === 'sl' ? Math.max(price, ref + eps) : Math.min(price, ref - eps);
      price = +price.toFixed(dp);
      if (dragState.setTarget === 'sl') p.stopLoss = price;
      else p.takeProfit = price;
      saveStorage();
      redrawPositionLines();
      renderPositions();
      updateHotStats();
      showToast(
        `已設定${dragState.setTarget === 'sl' ? '停損' : '停利'} → ${fmtPrice(price)}（預期 ${fmtMoneySigned(pnlAtPrice(p, price))}）`,
        'success',
      );
    }
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    dragState = null;
    return;
  }
  if (p) {
    saveStorage();
    // Reset title (remove dragging indicator)
    const lines = posLineMap.get(p.id);
    if (lines) {
      if (dragState.type === 'pentry')
        lines.entry.applyOptions({
          title: `⏳ ${p.side === 'long' ? 'L' : 'S'} 掛單 ${fmtPrice(p.entryPrice)}`,
        });
      if (lines.sl && p.stopLoss != null)
        lines.sl.applyOptions({ title: slLineTitle(p, p.stopLoss, false) });
      if (lines.tp && p.takeProfit != null)
        lines.tp.applyOptions({ title: tpLineTitle(p, p.takeProfit, false) });
    }
    if (dragState.type === 'pentry') {
      showToast(
        `已調整掛單價 → ${fmtPrice(p.entryPrice)}${p.stopLoss != null || p.takeProfit != null ? '（停損/停利同步平移）' : ''}`,
        'success',
      );
    } else {
      const _price = dragState.type === 'sl' ? p.stopLoss : p.takeProfit;
      showToast(
        `已更新${dragState.type === 'sl' ? '停損' : '停利'} → ${fmtPrice(_price)}（預期 ${fmtMoneySigned(pnlAtPrice(p, _price))}）`,
        'success',
      );
    }
  }
  document.body.style.cursor = '';
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  dragState = null;
}

function initDragSLTP() {
  const chartEl = $('chart');
  // Hover cursor feedback (only when not drawing and not already dragging)
  chart.subscribeCrosshairMove((param) => {
    if (dragState || state.drawingDrag || state.tool || store.posToolDrag) return;
    if (!param.point) {
      chartEl.style.cursor = '';
      return;
    }
    // Priority: 部位工具線 > SL/TP > 畫線
    if (state.posTool && posToolHitAtY(param.point.y)) {
      chartEl.style.cursor = 'ns-resize';
      return;
    }
    const slTpHit = findDraggableLineAtY(param.point.y);
    if (slTpHit) {
      chartEl.style.cursor = 'ns-resize';
      return;
    }
    // Then drawing hit
    const dHit = hitTestAllDrawings(param.point.x, param.point.y);
    if (dHit) {
      chartEl.style.cursor = dHit.mode === 'anchor' ? 'crosshair' : 'move';
      return;
    }
    chartEl.style.cursor = '';
  });

  // Capture mousedown BEFORE chart's pan handler
  chartEl.addEventListener(
    'mousedown',
    (e) => {
      if (state.tool || dragState || state.drawingDrag || store.posToolDrag) return;
      const rect = chartEl.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const x = e.clientX - rect.left;

      // 0) 圖表下單部位工具線
      if (state.posTool) {
        const hit = posToolHitAtY(y);
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          store.posToolDrag = hit;
          document.body.style.cursor = 'ns-resize';
          document.addEventListener('mousemove', onPosToolDragMove);
          document.addEventListener('mouseup', onPosToolDragEnd);
          return;
        }
      }

      // 1) SL/TP drag
      const slTpHit = findDraggableLineAtY(y);
      if (slTpHit) {
        e.preventDefault();
        e.stopPropagation();
        const lines = posLineMap.get(slTpHit.pos.id);
        if (!lines) return;
        dragState = {
          posId: slTpHit.pos.id,
          type: slTpHit.type,
          priceLine:
            slTpHit.type === 'sl'
              ? lines.sl
              : slTpHit.type === 'tp'
                ? lines.tp
                : slTpHit.type === 'pentry'
                  ? lines.entry
                  : null,
          originalPrice:
            slTpHit.type === 'sl'
              ? slTpHit.pos.stopLoss
              : slTpHit.type === 'tp'
                ? slTpHit.pos.takeProfit
                : slTpHit.pos.entryPrice,
          origSl: slTpHit.pos.stopLoss,
          origTp: slTpHit.pos.takeProfit,
        };
        // 成本線拖曳設定：用一條暫時虛線跟著游標，放開才真正設定停損/停利
        if (slTpHit.type === 'entryset') {
          dragState.tempLine = candleSeries.createPriceLine({
            price: slTpHit.pos.entryPrice,
            color: '#b2b5be',
            lineWidth: 1,
            lineStyle: 3,
            title: '↕ 往上設停利 / 往下設停損',
          });
        }
        document.body.style.cursor = 'ns-resize';
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
        return;
      }

      // 2) Drawing select / edit
      const dHit = hitTestAllDrawings(x, y);
      if (dHit) {
        e.preventDefault();
        e.stopPropagation();
        selectDrawing(dHit.drawing.id);
        // Start drag (anchor or whole-shape move)
        const startTime = chart.timeScale().coordinateToTime(x);
        const startPrice = candleSeries.coordinateToPrice(y);
        state.drawingDrag = {
          drawingId: dHit.drawing.id,
          mode: dHit.mode, // 'move' | 'anchor'
          anchorIdx: dHit.idx,
          startX: x,
          startY: y,
          startTime,
          startPrice,
          snapshot: JSON.parse(JSON.stringify(dHit.drawing.points)),
        };
        document.body.style.cursor = dHit.mode === 'anchor' ? 'crosshair' : 'move';
        document.addEventListener('mousemove', onDrawingDragMove);
        document.addEventListener('mouseup', onDrawingDragEnd);
        return;
      }

      // 3) Click on empty area while in cursor mode → deselect
      if (state.selectedDrawingId) {
        // Wait until mouseup to deselect to allow chart pan still
        const wasSelected = state.selectedDrawingId;
        const onUp = (upE) => {
          const dx = Math.abs(upE.clientX - e.clientX);
          const dy = Math.abs(upE.clientY - e.clientY);
          if (dx < 3 && dy < 3) {
            selectDrawing(null);
          }
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mouseup', onUp);
      }
    },
    true,
  );

  // Touch support：SL/TP/掛單線拖曳 + 繪圖選取/整體移動/錨點拖曳
  // （點位「放置」走 lightweight-charts 的 tap→subscribeClick，本來就支援觸控）
  // capture 階段攔截：否則 lightweight-charts 的 canvas handler 會先啟動平移手勢，
  // 造成「拖線的同時圖表也跟著滑」（滑鼠路徑用的是同樣的 capture + stopPropagation）
  chartEl.addEventListener(
    'touchstart',
    (e) => {
      if (
        state.tool ||
        dragState ||
        state.drawingDrag ||
        store.posToolDrag ||
        e.touches.length !== 1
      )
        return;
      const rect = chartEl.getBoundingClientRect();
      const y = e.touches[0].clientY - rect.top;
      const x = e.touches[0].clientX - rect.left;

      // 0) 圖表下單部位工具線（與滑鼠路徑同順序）
      if (state.posTool) {
        const ptHit = posToolHitAtY(y);
        if (ptHit) {
          e.preventDefault();
          e.stopPropagation();
          store.posToolDrag = ptHit;
          const ptMove = (ev) => {
            if (ev.touches.length !== 1) return;
            ev.preventDefault();
            onPosToolDragMove({ clientY: ev.touches[0].clientY });
          };
          const ptEnd = () => {
            onPosToolDragEnd();
            document.removeEventListener('touchmove', ptMove);
            document.removeEventListener('touchend', ptEnd);
            document.removeEventListener('touchcancel', ptEnd);
          };
          document.addEventListener('touchmove', ptMove, { passive: false });
          document.addEventListener('touchend', ptEnd);
          document.addEventListener('touchcancel', ptEnd);
          return;
        }
      }

      const hit = findDraggableLineAtY(y);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        const lines = posLineMap.get(hit.pos.id);
        if (!lines) return;
        dragState = {
          posId: hit.pos.id,
          type: hit.type,
          priceLine:
            hit.type === 'sl'
              ? lines.sl
              : hit.type === 'tp'
                ? lines.tp
                : hit.type === 'pentry'
                  ? lines.entry
                  : null,
          originalPrice:
            hit.type === 'sl'
              ? hit.pos.stopLoss
              : hit.type === 'tp'
                ? hit.pos.takeProfit
                : hit.pos.entryPrice,
        };
        dragState.origSl = hit.pos.stopLoss;
        dragState.origTp = hit.pos.takeProfit;
        if (hit.type === 'entryset') {
          dragState.tempLine = candleSeries.createPriceLine({
            price: hit.pos.entryPrice,
            color: '#b2b5be',
            lineWidth: 1,
            lineStyle: 3,
            title: '↕ 往上設停利 / 往下設停損',
          });
        }
        const touchMove = (ev) => {
          if (ev.touches.length !== 1) return;
          ev.preventDefault();
          onDragMove({ clientY: ev.touches[0].clientY });
        };
        const unbind = () => {
          document.removeEventListener('touchmove', touchMove);
          document.removeEventListener('touchend', touchEnd);
          document.removeEventListener('touchcancel', touchCancel);
        };
        const touchEnd = () => {
          onDragEnd();
          unbind();
        };
        // 來電／通知列／邊緣返回手勢會送 touchcancel：視為放棄本次調整並還原，不可當成確認
        const touchCancel = () => {
          cancelLineDrag();
          unbind();
        };
        document.addEventListener('touchmove', touchMove, { passive: false });
        document.addEventListener('touchend', touchEnd);
        document.addEventListener('touchcancel', touchCancel);
        return;
      }
      // 繪圖：碰到就選取（浮出刪除列），並可直接拖曳（錨點細調 / 整體平移）
      const dHit = hitTestAllDrawings(x, y);
      if (dHit) {
        e.preventDefault();
        e.stopPropagation();
        selectDrawing(dHit.drawing.id);
        const startTime = chart.timeScale().coordinateToTime(x);
        const startPrice = candleSeries.coordinateToPrice(y);
        state.drawingDrag = {
          drawingId: dHit.drawing.id,
          mode: dHit.mode,
          anchorIdx: dHit.idx,
          startX: x,
          startY: y,
          startTime,
          startPrice,
          snapshot: JSON.parse(JSON.stringify(dHit.drawing.points)),
        };
        const dMove = (ev) => {
          if (ev.touches.length !== 1) return;
          ev.preventDefault();
          onDrawingDragMove({
            clientX: ev.touches[0].clientX,
            clientY: ev.touches[0].clientY,
          });
        };
        const dUnbind = () => {
          document.removeEventListener('touchmove', dMove);
          document.removeEventListener('touchend', dEnd);
          document.removeEventListener('touchcancel', dCancel);
        };
        const dEnd = () => {
          onDrawingDragEnd();
          dUnbind();
        };
        // 中斷時把圖形還原成拖曳前的座標
        const dCancel = () => {
          const dd = state.drawingDrag;
          if (dd) {
            const dr = getCurrentDrawings().find((x) => x.id === dd.drawingId);
            if (dr && dd.snapshot) dr.points = JSON.parse(JSON.stringify(dd.snapshot));
          }
          onDrawingDragEnd();
          redrawDrawings();
          dUnbind();
        };
        document.addEventListener('touchmove', dMove, { passive: false });
        document.addEventListener('touchend', dEnd);
        document.addEventListener('touchcancel', dCancel);
        return;
      }
      // 空白處輕點：取消選取（與桌面行為一致）
      if (state.selectedDrawingId) {
        const t0 = e.touches[0];
        const onTouchUp = (upE) => {
          const t1 = upE.changedTouches && upE.changedTouches[0];
          if (
            t1 &&
            Math.abs(t1.clientX - t0.clientX) < 6 &&
            Math.abs(t1.clientY - t0.clientY) < 6
          ) {
            selectDrawing(null);
          }
          document.removeEventListener('touchend', onTouchUp);
          document.removeEventListener('touchcancel', onTouchUp);
        };
        document.addEventListener('touchend', onTouchUp);
        document.addEventListener('touchcancel', onTouchUp);
      }
    },
    { passive: false, capture: true },
  );
}

// ---- Drawing selection / drag ----
function selectDrawing(id) {
  state.selectedDrawingId = id;
  if (id) {
    const d = getCurrentDrawings().find((x) => x.id === id);
    if (d) {
      const c = d.style?.color || d.color;
      $$('#draw-color-row button').forEach((b) =>
        b.classList.toggle('active', b.dataset.color === c),
      );
    }
  }
  redrawDrawings();
  if (typeof refreshTemplatesPanel === 'function') refreshTemplatesPanel();
}

function onDrawingDragMove(e) {
  const dd = state.drawingDrag;
  if (!dd) return;
  const chartEl = $('chart');
  const rect = chartEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const newTime = chart.timeScale().coordinateToTime(x);
  const newPrice = candleSeries.coordinateToPrice(y);
  if (newTime == null || newPrice == null) return;

  const d = getCurrentDrawings().find((x) => x.id === dd.drawingId);
  if (!d) return;

  if (dd.mode === 'anchor') {
    const idx = dd.anchorIdx;
    if (d.type === 'hline') {
      d.points[0] = { time: dd.snapshot[0].time, price: newPrice };
    } else if (d.type === 'vline') {
      d.points[0] = { time: newTime, price: dd.snapshot[0].price };
    } else {
      d.points[idx] = { time: newTime, price: newPrice };
    }
  } else {
    // 'move': 以「K 棒索引」平移（不是時間戳相加），落點才保證是真實 K 棒
    const maxIdx = Math.min(
      state.cursorIndex >= 0 ? state.cursorIndex : state.candles.length - 1,
      state.candles.length - 1,
    );
    // 位移量整體 clamp（不是逐點）：碰到邊界時整個圖形一起停住，
    // 逐點 clamp 會讓遠端卡住、近端繼續走，圖形被壓扁且拖不回來
    const idxs = dd.snapshot.map((pt) => timeToIndex(pt.time));
    const shapeMin = Math.min(...idxs),
      shapeMax = Math.max(...idxs);
    const deltaIdx = Math.max(
      -shapeMin,
      Math.min(maxIdx - shapeMax, timeToIndex(newTime) - timeToIndex(dd.startTime)),
    );
    const shiftTime = (t) => {
      const ni = timeToIndex(t) + deltaIdx;
      return state.candles[ni] ? state.candles[ni].time : t;
    };
    const deltaPrice = newPrice - dd.startPrice;
    for (let i = 0; i < d.points.length; i++) {
      const orig = dd.snapshot[i];
      d.points[i] = {
        time: shiftTime(orig.time),
        price: orig.price + deltaPrice,
      };
    }
    if (d.type === 'hline') d.points = [{ time: d.points[0].time, price: d.points[0].price }];
  }
  redrawDrawings();
}

function onDrawingDragEnd() {
  if (!state.drawingDrag) return;
  state.drawingDrag = null;
  document.body.style.cursor = '';
  document.removeEventListener('mousemove', onDrawingDragMove);
  document.removeEventListener('mouseup', onDrawingDragEnd);
  saveStorage();
}

function deleteSelectedDrawing() {
  const id = state.selectedDrawingId;
  if (!id) return;
  const arr = getCurrentDrawings();
  const idx = arr.findIndex((x) => x.id === id);
  if (idx < 0) return;
  arr.splice(idx, 1);
  state.selectedDrawingId = null;
  saveStorage();
  redrawDrawings();
  showToast('已刪除', 'success');
}

function recolorSelectedDrawing(color) {
  const id = state.selectedDrawingId;
  if (!id) return false;
  const d = getCurrentDrawings().find((x) => x.id === id);
  if (!d) return false;
  if (!d.style) d.style = { color, lineWidth: 1.5, lineStyle: 0, label: '' };
  d.style.color = color;
  d.color = color; // back-compat
  saveStorage();
  redrawDrawings();
  return true;
}

export {
  cancelLineDrag,
  deleteSelectedDrawing,
  dragState,
  initDragSLTP,
  onDrawingDragEnd,
  recolorSelectedDrawing,
  selectDrawing,
};
