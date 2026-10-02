import { finishBlindSession } from './blind.js';
import { fmtMoneySigned, pnlAtPrice } from './chart.js';
import {
  dispSym,
  getPointValue,
  inScope,
  isMasked,
  posPV,
  sizeStr,
  store,
  symInfo,
  symLabel,
} from './constants.js';
import { clearPosTool, redrawPositionLines } from './drawings.js';
import { stopPlay } from './replay.js';
import { state } from './state.js';
import { saveStorage } from './storage.js';
import {
  currentEquity,
  renderReport,
  renderTrades,
  switchSidePane,
  updateHotStats,
} from './trades.js';
import {
  $,
  $$,
  escHtml,
  fmtDateTime,
  fmtMoney,
  fmtPrice,
  fmtR,
  priceDp,
  showToast,
  uid,
} from './util.js';

// ---------- Order placement ----------
function refreshOrderForm() {
  // Default entry = current bar close
  const c = state.candles[state.cursorIndex];
  if (!c) return;
  // 低價標的（SHIB/PEPE 等）需要更多小數位，否則 0.5% 的停損距離會被捨進位吃掉
  const dp = priceDp(c.close);
  const entryEl = $('order-entry');
  if (!entryEl.dataset.touched) entryEl.value = c.close.toFixed(dp);
  // 停損/停利為選填：不自動帶入（部位工具會填三價；使用者填過的值保留）
  const slEl = $('order-sl'),
    tpEl = $('order-tp');
  if (!slEl.dataset.touched) slEl.value = '';
  if (!tpEl.dataset.touched) tpEl.value = '';
  updateOrderSummary();
}
function clearOrderTouched() {
  ['order-entry', 'order-sl', 'order-tp'].forEach((id) => delete $(id).dataset.touched);
}
function setOrderSide(side) {
  state.orderSide = side;
  $$('.order-side-toggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.orderSide === side),
  );
  const submitBtn = $('btn-submit-order');
  submitBtn.className = 'btn-submit ' + side;
  submitBtn.textContent = side === 'long' ? '送出做多單' : '送出做空單';
  // Reset SL/TP suggestions if not touched
  refreshOrderForm();
}
function calcOrderSize(entry, sl, riskPct, balance) {
  // 未設停損時以進場價 1% 當預設風險距離估算部位（單筆風險金額不變）
  const noSl = !(sl > 0);
  const dist = noSl ? entry * 0.01 : Math.abs(entry - sl);
  if (dist <= 0) return { size: 0, riskAmount: 0, dist, noSl };
  const riskAmount = balance * (riskPct / 100);
  const ptValue = getPointValue(state.symbol);
  const size = riskAmount / (dist * ptValue);
  return { size, riskAmount, dist, noSl };
}
function updateOrderSummary() {
  const entry = +$('order-entry').value;
  const sl = +$('order-sl').value || null;
  const tp = +$('order-tp').value || null;
  const riskPct = +$('order-risk').value;
  const balance = state.settings.balance;
  const side = state.orderSide;

  const summary = $('order-summary');
  if (!entry || !riskPct) {
    summary.innerHTML =
      '<div class="row"><span>填進場價與風險 % 後顯示摘要（停損/停利選填）</span></div>';
    $('order-size-hint').textContent = '部位大小將依停損距離自動計算';
    return;
  }
  // 方向驗證：只驗有填的欄位（失敗時同步清掉 size hint，避免殘留舊值）
  if (sl != null && (side === 'long' ? sl >= entry : sl <= entry)) {
    summary.innerHTML = `<div class="row"><span style="color:var(--warn);">${side === 'long' ? '停損須低於進場價' : '停損須高於進場價'}</span></div>`;
    $('order-size-hint').textContent = '部位大小將依停損距離自動計算';
    return;
  }
  if (tp != null && (side === 'long' ? tp <= entry : tp >= entry)) {
    summary.innerHTML = `<div class="row"><span style="color:var(--warn);">${side === 'long' ? '停利須高於進場價' : '停利須低於進場價'}</span></div>`;
    $('order-size-hint').textContent = '部位大小將依停損距離自動計算';
    return;
  }
  const { size, riskAmount, dist, noSl } = calcOrderSize(entry, sl, riskPct, balance);
  const ptValue = getPointValue(state.symbol);

  const sInfo = symInfo(state.symbol);
  $('order-size-hint').textContent =
    `部位大小 ≈ ${size.toFixed(sInfo.sizeDecimals)} ${sInfo.sizeUnit}` +
    (noSl ? '（未設停損，以進場價 1% 估算）' : '');
  const rows = [];
  rows.push(
    noSl
      ? '<div class="row"><span>停損</span><span class="v">未設，可進場後在圖上補</span></div>'
      : `<div class="row"><span>停損距離</span><span class="v">${fmtPrice(dist)} 點</span></div>`,
  );
  rows.push(
    `<div class="row risk"><span>單筆風險</span><span class="v">${fmtMoney(riskAmount)}</span></div>`,
  );
  if (tp != null) {
    const rewardDist = Math.abs(tp - entry);
    rows.push(
      `<div class="row reward"><span>停利目標</span><span class="v">${fmtMoney(rewardDist * ptValue * size)}</span></div>`,
    );
    rows.push(
      `<div class="row"><span>盈虧比 R:R</span><span class="v">1:${(rewardDist / dist).toFixed(2)}${noSl ? '（估）' : ''}</span></div>`,
    );
  } else {
    rows.push(
      '<div class="row"><span>停利</span><span class="v">未設，可進場後在圖上補</span></div>',
    );
  }
  summary.innerHTML = rows.join('');
}

let _submitLock = 0;
function submitOrder() {
  const c = state.candles[state.cursorIndex];
  if (!c) {
    showToast('請先載入資料', 'error');
    return;
  }
  // 手指/滑鼠連點兩下會送出兩張一模一樣的單，風險直接翻倍
  // （鎖只在「真的建倉」時才寫入——見下方 _submitLock = Date.now()；
  //   否則被驗證退件的單也會吃掉冷卻時間，使用者改好立刻重送會靜默失敗）
  if (Date.now() - _submitLock < 400) return;
  const entry = +$('order-entry').value;
  const sl = +$('order-sl').value || null;
  const tp = +$('order-tp').value || null;
  const riskPct = +$('order-risk').value;
  const strategy = $('order-strategy').value.trim();
  const reason = $('order-reason').value.trim();
  const side = state.orderSide;
  if (!entry || !riskPct) {
    showToast('請填寫進場價與風險 %', 'error');
    return;
  }
  // 停損/停利選填：有填才驗方向；未設停損以進場價 1% 估算部位，之後可在圖上補設
  if (sl != null && (side === 'long' ? sl >= entry : sl <= entry)) {
    showToast(side === 'long' ? '停損須低於進場價' : '停損須高於進場價', 'error');
    return;
  }
  if (tp != null && (side === 'long' ? tp <= entry : tp >= entry)) {
    showToast(side === 'long' ? '停利須高於進場價' : '停利須低於進場價', 'error');
    return;
  }
  // 策略標籤與進場理由皆為選填（教練建議填，但不擋單）

  const { size, riskAmount } = calcOrderSize(entry, sl, riskPct, state.settings.balance);
  if (size <= 0) {
    showToast('部位計算失敗', 'error');
    return;
  }

  // 掛單判定：進場價不在當根 K 棒範圍內 → 掛單（pending），等價格觸及才成交
  // 成交前不會觸發停損/停利，避免「沒成交卻達停利」的幽靈獲利
  const filled = entry <= c.high && entry >= c.low;
  const pos = {
    id: uid(),
    symbol: state.symbol,
    timeframe: state.timeframe,
    side,
    entryTime: c.time,
    entryPrice: entry,
    size,
    stopLoss: sl,
    takeProfit: tp,
    riskPct,
    riskAmount,
    strategyTag: strategy || '—',
    entryReason: reason || '—',
    status: filled ? 'open' : 'pending',
    createdAt: Date.now(),
    createdBarTime: c.time, // 下單當根：掛單成交判定的時間下限（回放倒退時不誤成交）
    chartTime: c.time,
    pv: getPointValue(state.symbol), // 點值快照（盲測正規化後仍算出正確金額）
    blindId: state.blind ? state.blind.id : null,
  };
  state.positions.push(pos);
  _submitLock = Date.now(); // 建倉成功才起算冷卻
  saveStorage();

  // Reset order form (keep risk/strategy)
  clearPosTool();
  $('order-reason').value = '';
  $('order-strategy').value = '';
  clearOrderTouched();
  refreshOrderForm();
  renderPositions();
  redrawPositionLines();
  updateHotStats();

  // Switch to positions tab
  switchSidePane('positions');
  showToast(
    filled
      ? `✓ 已建立${side === 'long' ? '多' : '空'}單 @ ${entry}`
      : `⏳ 已掛${side === 'long' ? '多' : '空'}單 @ ${entry}，價格觸及才會成交`,
    'success',
  );
}

// ---------- Position management ----------
function renderPositions() {
  const cont = $('positions-list');
  const c = state.candles[state.cursorIndex];
  // 盲測中只顯示本輪盲測部位；平時只顯示一般部位（含未成交掛單）
  const open = state.positions.filter(
    (p) => (p.status === 'open' || p.status === 'pending') && inScope(p),
  );
  $('badge-pos').style.display = open.length > 0 ? 'inline' : 'none';
  $('pos-count').textContent = open.length;
  // 一鍵平倉只在「真的按得動」時出現：一鍵平倉碰不到別的標的／週期，
  // 所以光有其他標的部位不算數，否則按下去只會跳一句「沒有可處理的部位」
  $('btn-close-all').style.display = open.some(
    (p) => p.symbol === state.symbol && p.timeframe === state.timeframe,
  )
    ? 'inline-block'
    : 'none';

  if (!open.length) {
    cont.innerHTML = state.blind
      ? '<div class="empty">本輪盲測尚無持倉<br>切到「下單」分頁建立模擬交易</div>'
      : '<div class="empty">目前無持倉<br>切到「下單」分頁建立模擬交易</div>';
    return;
  }
  cont.innerHTML = open
    .map((p) => {
      const pending = p.status === 'pending';
      const isCurrent = p.symbol === state.symbol && p.timeframe === state.timeframe;
      const cur = isCurrent && c ? c.close : p.entryPrice;
      const dir = p.side === 'long' ? 1 : -1;
      const pnlPts = pending ? 0 : (cur - p.entryPrice) * dir;
      const pnl = pnlPts * posPV(p) * p.size;
      const rMul = p.riskAmount > 0 ? pnl / p.riskAmount : 0;
      const pnlClass = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
      return `
<div class="pos-card ${p.side}">
  <div class="pos-head">
    <div>
      <span class="pos-side ${p.side}">${p.side === 'long' ? '多' : '空'}</span>
      <span style="color:var(--text);font-weight:600;margin-left:6px;">${dispSym(p)}</span>
      <span style="color:var(--text-3);margin-left:4px;">${p.timeframe}</span>
    </div>
    ${
      pending
        ? '<div class="pos-pnl" style="color:var(--text-3);">⏳ 掛單中</div>'
        : !isCurrent
          ? '<div class="pos-pnl" style="color:var(--text-3);">—</div>'
          : `<div class="pos-pnl ${pnlClass}">${fmtMoney(pnl)} <span style="font-size:10px;">${fmtR(rMul)}</span></div>`
    }
  </div>
  <div class="pos-row"><span>${pending ? '掛單價' : '進場'}</span><span class="v">${fmtPrice(p.entryPrice)} · ${isMasked(p) ? '❓' : fmtDateTime(p.entryTime, p.timeframe)}</span></div>
  <div class="pos-row"><span>停損</span><span class="v">${
    p.stopLoss != null
      ? `${fmtPrice(p.stopLoss)} · <span style="color:${pnlAtPrice(p, p.stopLoss) >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'};">${fmtMoneySigned(pnlAtPrice(p, p.stopLoss))}</span>`
      : '—（未設）'
  }</span></div>
  <div class="pos-row"><span>停利</span><span class="v">${
    p.takeProfit != null
      ? `${fmtPrice(p.takeProfit)} · <span style="color:${pnlAtPrice(p, p.takeProfit) >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'};">${fmtMoneySigned(pnlAtPrice(p, p.takeProfit))}</span>`
      : '—（未設）'
  }</span></div>
  <div class="pos-row"><span>部位</span><span class="v">${sizeStr(p)} · 風險 ${fmtMoney(p.riskAmount)}</span></div>
  <div class="pos-row"><span>策略</span><span class="v">${escHtml(p.strategyTag)}</span></div>
  ${
    isCurrent
      ? pending
        ? `<div class="pos-actions">
    <button class="btn-close-pos" data-cancel-pos="${p.id}">取消掛單</button>
  </div>`
        : `<div class="pos-actions">
    ${p.stopLoss == null ? `<button class="btn-add-line" data-add-sl="${p.id}">＋停損</button>` : ''}
    ${p.takeProfit == null ? `<button class="btn-add-line" data-add-tp="${p.id}">＋停利</button>` : ''}
    <button class="btn-close-pos" data-close-pos="${p.id}">市價平倉</button>
  </div>`
      : `<div class="field-hint" style="margin-top:6px;">切換到 ${dispSym(p)} ${p.timeframe} 才能管理</div>`
  }
</div>
    `;
    })
    .join('');
  cont
    .querySelectorAll('[data-close-pos]')
    .forEach((b) => b.addEventListener('click', () => openCloseModal(b.dataset.closePos)));
  cont
    .querySelectorAll('[data-add-sl]')
    .forEach((b) => b.addEventListener('click', () => addPosStop(b.dataset.addSl, 'sl')));
  cont
    .querySelectorAll('[data-add-tp]')
    .forEach((b) => b.addEventListener('click', () => addPosStop(b.dataset.addTp, 'tp')));
  cont
    .querySelectorAll('[data-cancel-pos]')
    .forEach((b) => b.addEventListener('click', () => cancelPendingOrder(b.dataset.cancelPos)));
}

// 取消未成交掛單（不留任何紀錄）
function cancelPendingOrder(posId) {
  const p = state.positions.find((x) => x.id === posId && x.status === 'pending');
  if (!p) return;
  state.positions = state.positions.filter((x) => x.id !== posId);
  saveStorage();
  renderPositions();
  redrawPositionLines();
  updateHotStats();
  showToast('已取消掛單', 'success');
}

// 一鍵平倉：把當前 scope 裡「按得動」的部位一次清乾淨
// 只碰同標的同週期——理由同 confirmManualClose：拿別的商品的 K 棒平倉，
// 會寫出價格與時間都錯亂的假交易，之後整份統計都不能信
function closeAllPositions() {
  const c = state.candles[state.cursorIndex];
  if (!c) return;
  const here = (p) => p.symbol === state.symbol && p.timeframe === state.timeframe;
  const scoped = state.positions.filter(
    (p) => (p.status === 'open' || p.status === 'pending') && inScope(p),
  );
  const opens = scoped.filter((p) => p.status === 'open' && here(p));
  const pendings = scoped.filter((p) => p.status === 'pending' && here(p));
  const others = scoped.filter((p) => !here(p));
  if (!opens.length && !pendings.length) {
    showToast('目前沒有可一鍵處理的部位', 'error');
    return;
  }
  if (
    !confirm(
      `確定一鍵平倉？將以現價平掉 ${opens.length} 筆持倉、取消 ${pendings.length} 張掛單。此動作會寫入交易紀錄，無法復原。`,
    )
  )
    return;
  for (const p of opens) closePosition(p, c.close, '一鍵平倉', c.time, '一鍵平倉');
  // 掛單直接移除、不留紀錄（未成交不算交易），比照 cancelPendingOrder
  const dropIds = new Set(pendings.map((p) => p.id));
  if (dropIds.size) state.positions = state.positions.filter((x) => !dropIds.has(x.id));
  // 平倉視窗若正對著剛被清掉的部位，一併收掉，否則會留下一個按了沒反應的死視窗
  if (
    store._closeTargetId &&
    (dropIds.has(store._closeTargetId) || opens.some((p) => p.id === store._closeTargetId))
  ) {
    $('close-modal').classList.remove('show');
    store._closeTargetId = null;
  }
  saveStorage();
  // 整批跑完才重繪一次：逐筆重繪在十幾筆部位時會明顯卡頓
  renderPositions();
  renderTrades();
  renderReport();
  updateHotStats();
  redrawPositionLines();
  showToast(
    `✓ 已平倉 ${opens.length} 筆、取消 ${pendings.length} 張掛單` +
      (others.length ? `；另有 ${others.length} 筆在其他標的，切換過去才能處理` : ''),
    'success',
  );
  // 熔斷同樣只跑一次：批次一次產生多筆虧損，逐筆檢查會連彈好幾個 modal
  // didClose 口徑比照 checkPositionTriggers——取消掛單不是平倉，不該觸發熔斷
  // 爆倉優先：已經出局就不必再提醒連敗
  if (!checkBlowUp() && opens.length) checkLossStreak();
}

// 進場後補設停損/停利：先放預設位置，再讓使用者到圖上拖曳調整
function addPosStop(posId, type) {
  const p = state.positions.find((x) => x.id === posId);
  const c = state.candles[state.cursorIndex];
  if (!p || !c) return;
  if (type === 'sl' ? p.stopLoss != null : p.takeProfit != null) return; // 已有就不覆蓋
  const dp = priceDp(c.close);
  const dir = p.side === 'long' ? 1 : -1;
  let price;
  if (type === 'sl') {
    // 與停利對稱：取現價與進場價中較不利的一側再外推，避免「達停損」卻是獲利出場
    const base =
      p.side === 'long' ? Math.min(c.close, p.entryPrice) : Math.max(c.close, p.entryPrice);
    price = base - dir * base * 0.01;
  } else {
    // 停利以「現價與進場價較有利一側」再外推 1%：虧損中補停利不會落在進場價錯邊
    // （否則出場會被標成「達停利」但實際是虧損，污染統計）
    const base =
      p.side === 'long' ? Math.max(c.close, p.entryPrice) : Math.min(c.close, p.entryPrice);
    price = base + dir * base * 0.01;
  }
  if (type === 'sl') p.stopLoss = +price.toFixed(dp);
  else p.takeProfit = +price.toFixed(dp);
  saveStorage();
  redrawPositionLines();
  renderPositions();
  const newPrice = type === 'sl' ? p.stopLoss : p.takeProfit;
  showToast(
    `已加上${type === 'sl' ? '停損' : '停利'}線 @ ${fmtPrice(newPrice)}（預期 ${fmtMoneySigned(pnlAtPrice(p, newPrice))}），可在圖表上拖曳調整`,
    'success',
  );
}

function updateCloseInfo() {
  const p = state.positions.find((x) => x.id === store._closeTargetId);
  const c = state.candles[state.cursorIndex];
  if (!p || !c) return;
  const dir = p.side === 'long' ? 1 : -1;
  const pnlPts = (c.close - p.entryPrice) * dir;
  const part = p.size * store._closeFrac;
  const pnl = pnlPts * posPV(p) * part;
  const info = symInfo(p.symbol);
  $('close-info').innerHTML = `
    <strong>${dispSym(p)}</strong> ${p.side === 'long' ? '多單' : '空單'} ·
    進場 ${fmtPrice(p.entryPrice)} → 平倉 <strong>${fmtPrice(c.close)}</strong><br>
    平掉 <strong>${part.toFixed(info.sizeDecimals)} ${info.sizeUnit}</strong>（${Math.round(store._closeFrac * 100)}%）
    ${store._closeFrac < 1 ? `，續抱 ${(p.size - part).toFixed(info.sizeDecimals)} ${info.sizeUnit}` : ''}<br>
    預估盈虧: <strong style="color:${pnl >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'}">${fmtMoney(pnl)}</strong>
  `;
}
function openCloseModal(posId) {
  const p = state.positions.find((x) => x.id === posId);
  if (!p || p.status !== 'open') return; // 未成交掛單只能取消，不能平倉
  // 非當前標的/週期不能平倉：出場價會取到別的商品的 K 棒
  if (p.symbol !== state.symbol || p.timeframe !== state.timeframe) {
    showToast(`請先切換到 ${symLabel(p.symbol)} ${p.timeframe} 再平倉`, 'error');
    return;
  }
  store._closeTargetId = posId;
  const c = state.candles[state.cursorIndex];
  if (!c) return;
  store._closeFrac = 1;
  $$('#close-frac-row button').forEach((b) => b.classList.toggle('active', b.dataset.frac === '1'));
  updateCloseInfo();
  const dir = p.side === 'long' ? 1 : -1;
  const pnl = (c.close - p.entryPrice) * dir * posPV(p) * p.size;
  $('close-reason').value = pnl >= 0 ? '提前獲利了結' : '提前砍單停損';
  $('close-note').value = '';
  $('close-modal').classList.add('show');
}
// 部分平倉：平掉的部分成為一筆獨立交易紀錄（風險額按比例分攤，R 各算各的）
function closePartialPosition(p, frac, exitPrice, exitReason, exitTime, exitNote) {
  const part = p.size * frac;
  const partRisk = p.riskAmount * frac;
  const partPct = p.riskPct * frac;
  const dir = p.side === 'long' ? 1 : -1;
  const pnlPts = (exitPrice - p.entryPrice) * dir;
  const pnl = pnlPts * posPV(p) * part;
  const rec = {
    ...p,
    id: uid(),
    parentId: p.id, // 同源標記：同一原始部位的分筆不重複計入連敗
    size: part,
    riskAmount: partRisk,
    riskPct: +partPct.toFixed(4), // 風險 % 同步按比例縮放（否則明細金額與 % 互相矛盾）
    status: 'closed',
    exitPrice,
    exitReason,
    exitTime,
    exitNote: `${exitNote ? exitNote + ' ' : ''}（部分平倉 ${Math.round(frac * 100)}%）`,
    pnl,
    pnlPts,
    rMultiple: partRisk > 0 ? pnl / partRisk : 0,
  };
  state.trades.unshift(rec);
  p.size -= part;
  p.riskAmount -= partRisk;
  p.riskPct = +(p.riskPct - partPct).toFixed(4);
  saveStorage();
}
function confirmManualClose() {
  const p = state.positions.find((x) => x.id === store._closeTargetId);
  const c = state.candles[state.cursorIndex];
  // 部位可能在視窗開著時已被停損/停利平掉——關窗並說明，不要靜默無反應
  if (!p || p.status !== 'open') {
    $('close-modal').classList.remove('show');
    store._closeTargetId = null;
    showToast('這個部位已經不在了（可能已觸價出場）', 'error');
    return;
  }
  // 視窗開著時被切到別的標的/週期：現在的 K 棒屬於另一個商品，
  // 用它平倉會寫出價格與時間都錯亂的假交易，直接擋下
  if (p.symbol !== state.symbol || p.timeframe !== state.timeframe) {
    $('close-modal').classList.remove('show');
    store._closeTargetId = null;
    showToast(`已切換標的，請切回 ${symLabel(p.symbol)} ${p.timeframe} 再平倉`, 'error');
    return;
  }
  if (!c) return;
  const reason = $('close-reason').value;
  const note = $('close-note').value.trim();
  if (store._closeFrac < 0.999)
    closePartialPosition(p, store._closeFrac, c.close, reason, c.time, note);
  else closePosition(p, c.close, reason, c.time, note);
  $('close-modal').classList.remove('show');
  store._closeTargetId = null;
  renderPositions();
  renderTrades();
  renderReport();
  updateHotStats();
  redrawPositionLines();
  showToast(
    store._closeFrac < 0.999
      ? `✓ 已部分平倉 ${Math.round(store._closeFrac * 100)}%，剩餘續抱`
      : '✓ 已平倉',
    'success',
  );
  if (!checkBlowUp()) checkLossStreak(); // 爆倉優先：已經出局就不必再提醒連敗
}

function closePosition(p, exitPrice, exitReason, exitTime, exitNote) {
  p.status = 'closed';
  p.exitPrice = exitPrice;
  p.exitReason = exitReason;
  p.exitTime = exitTime;
  p.exitNote = exitNote || '';
  const dir = p.side === 'long' ? 1 : -1;
  const pnlPts = (exitPrice - p.entryPrice) * dir;
  const pnl = pnlPts * posPV(p) * p.size;
  p.pnl = pnl;
  p.pnlPts = pnlPts;
  // R = 盈虧 ÷ 進場時風險金額（停損未設或事後拖動都算得出正確 R）
  const dist = p.stopLoss != null ? Math.abs(p.entryPrice - p.stopLoss) : 0;
  p.rMultiple = p.riskAmount > 0 ? pnl / p.riskAmount : dist > 0 ? pnlPts / dist : 0;
  p.holdBars = null; // computed if needed
  // move from positions to trades
  state.positions = state.positions.filter((x) => x.id !== p.id);
  state.trades.unshift(p);
  saveStorage();
}

// ---------- 連敗熔斷 ----------
// 目前 scope（盲測輪內 / 自由模式）最近的連續虧損筆數
// 已通知過的連敗數，依 scope 分開記（盲測輪與自由模式各自獨立，不互相汙染）
let _fuseNotified = {};
function fuseScopeKey() {
  return state.blind ? state.blind.id : 'free';
}
function currentLossStreak() {
  const list = state.blind
    ? state.trades.filter((t) => t.blindId === state.blind.id)
    : state.trades.filter((t) => !t.blindId);
  // 同一原始部位的分批出場算「一筆」——分三段停損不該被當成連虧三次
  // 用 Set 而非比對前一筆：分批中間被其他部位的平倉插隊時也要正確合併
  const seen = new Set();
  for (const t of list) {
    // unshift 存入 → index 0 = 最新
    if ((t.pnl || 0) >= 0) break;
    seen.add(t.parentId || t.id);
  }
  return seen.size;
}
// 連虧 3/5/7 筆時暫停回放並跳提醒；贏一筆歸零
function checkLossStreak() {
  const n = currentLossStreak();
  const key = fuseScopeKey();
  if (n < 3) {
    delete _fuseNotified[key];
    return;
  }
  if ((n === 3 || n === 5 || n === 7) && _fuseNotified[key] !== n) {
    _fuseNotified[key] = n;
    stopPlay();
    $('fuse-body').innerHTML =
      `你已經<strong style="color:var(--danger-2);">連續虧損 ${n} 筆</strong>——先停一下。`;
    $('fuse-modal').classList.add('show');
  }
}

// ---------- 餘額歸零強制出局（爆倉） ----------
// 已宣告出局的 scope，依 fuseScopeKey() 分開記（比照 _fuseNotified，盲測輪與自由模式互不汙染）
let _blownUp = {};
function checkBlowUp() {
  const key = fuseScopeKey();
  if (_blownUp[key]) return false;
  const eq = currentEquity();
  // NaN 不是 <= 0：算不出權益（資料壞掉、部位欄位缺值）時寧可不判，
  // 否則會用一個「畫面顯示 —」的數字把使用者判出局，怎麼解釋都解釋不通
  if (!Number.isFinite(eq.total)) return false;
  if (eq.total > 0) {
    store._blowUpArmed = true;
    return false;
  }
  if (!store._blowUpArmed) return false; // 開場就是負的 → 是上一輪的殘值，不重複宣告
  _blownUp[key] = true;
  store._blowUpArmed = false;
  stopPlay();
  const b = state.blind;
  const c = state.candles[state.cursorIndex];
  let closed = 0,
    cancelled = 0,
    others = 0;
  if (b) {
    // 盲測：finishBlindSession 本來就會取消掛單、把未平倉部位以現價平掉，
    // 自己再平一次會重複寫紀錄，所以這裡只數數字給提示用，實際結算交給它
    const scoped = state.positions.filter((p) => p.blindId === b.id);
    closed = scoped.filter((p) => p.status === 'open').length;
    cancelled = scoped.filter((p) => p.status === 'pending').length;
  } else {
    // 自由模式沒有盲測輪可結算，自己清場；一樣不碰其他標的／週期（假交易問題同 closeAllPositions）
    const here = (p) => p.symbol === state.symbol && p.timeframe === state.timeframe;
    const scoped = state.positions.filter(
      (p) => (p.status === 'open' || p.status === 'pending') && inScope(p),
    );
    others = scoped.filter((p) => !here(p)).length;
    const opens = scoped.filter((p) => p.status === 'open' && here(p));
    const dropIds = new Set(
      scoped.filter((p) => p.status === 'pending' && here(p)).map((p) => p.id),
    );
    closed = opens.length;
    cancelled = dropIds.size;
    if (c)
      for (const p of opens) closePosition(p, c.close, '爆倉強制平倉', c.time, '餘額歸零強制出局');
    if (dropIds.size) state.positions = state.positions.filter((x) => !dropIds.has(x.id));
  }
  if (store._closeTargetId) {
    // 部位已被清掉，開著的平倉視窗會變成死視窗
    $('close-modal').classList.remove('show');
    store._closeTargetId = null;
  }
  if (b) {
    finishBlindSession('爆倉出局', { blownUp: true }); // 內含清場、揭曉、寫入 blindHistory
  } else {
    saveStorage();
    renderPositions();
    renderTrades();
    renderReport();
    updateHotStats();
    redrawPositionLines();
  }
  // 數字在清場之後才取：浮虧這時已經變成已實現，
  // 否則會出現「餘額 -1 元、起始 10 萬、已實現 0」這種怎麼加都對不起來的三個數字
  const eqAfter = currentEquity();
  $('blowup-body').innerHTML =
    `你的<strong>餘額只剩 ${escHtml(fmtMoney(eqAfter.total))}</strong>——<strong style="color:var(--danger-2);">錢輸光了，本輪結束</strong>。<br>` +
    `起始資金 ${escHtml(fmtMoney(eqAfter.balance))}，已實現盈虧 ${escHtml(fmtMoney(eqAfter.realized))}。<br>` +
    `已強制平掉 ${closed} 筆持倉、取消 ${cancelled} 張掛單。` +
    (others ? `<br>另有 ${others} 筆在其他標的，切換過去才能處理。` : '');
  $('fuse-modal').classList.remove('show'); // 爆倉的優先級高於連敗提醒，不要兩個視窗疊著
  $('blowup-modal').classList.add('show');
  return true;
}

export {
  _blownUp,
  _fuseNotified,
  calcOrderSize,
  checkBlowUp,
  checkLossStreak,
  clearOrderTouched,
  closeAllPositions,
  closePosition,
  confirmManualClose,
  openCloseModal,
  refreshOrderForm,
  renderPositions,
  setOrderSide,
  submitOrder,
  updateCloseInfo,
  updateOrderSummary,
};
