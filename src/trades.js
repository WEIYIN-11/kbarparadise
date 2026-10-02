import { candleSeries, renderChart } from './chart.js';
import { dispSym, inScope, isMasked, posPV, sizeStr, store, symInfo } from './constants.js';
import { refreshOrderForm, renderPositions } from './orders.js';
import { loadAndStart, stopPlay, syncTopbarUI, updateReplayInfo } from './replay.js';
import { state } from './state.js';
import { saveStorage } from './storage.js';
import { $, $$, escHtml, fmtDateTime, fmtMoney, fmtPrice, fmtR, showToast } from './util.js';

// ---------- Trade list ----------
function renderTrades() {
  const cont = $('trades-list');
  // 盲測中只列本輪盲測交易（且遮罩名稱），平時列全部
  const list = state.blind
    ? state.trades.filter((t) => t.blindId === state.blind.id)
    : state.trades;
  if (!list.length) {
    cont.innerHTML = state.blind
      ? '<div class="empty">本輪盲測尚無平倉紀錄</div>'
      : '<div class="empty">尚無已平倉交易紀錄</div>';
    return;
  }
  cont.innerHTML = list
    .map(
      (t) => `
    <div class="trade-row ${t.side}" data-trade="${t.id}">
<div class="top">
  <span class="sym">${dispSym(t)} ${t.side === 'long' ? '多' : '空'} · ${t.timeframe}</span>
  <span class="pnl ${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}" style="color:${t.pnl >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'}">${fmtMoney(t.pnl)} ${fmtR(t.rMultiple)}</span>
</div>
<div class="meta">
  <span>${escHtml(t.strategyTag)} → ${escHtml(t.exitReason)}</span>
  <span>${isMasked(t) ? '❓' : fmtDateTime(t.entryTime, t.timeframe)}</span>
</div>
    </div>
  `,
    )
    .join('');
  cont
    .querySelectorAll('[data-trade]')
    .forEach((r) => r.addEventListener('click', () => openTradeModal(r.dataset.trade)));
}

function openTradeModal(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  $('trade-modal-body').innerHTML = `
    <div style="font-size:13px;line-height:1.8;">
<div><strong>${dispSym(t)} ${t.side === 'long' ? '多單' : '空單'} · ${t.timeframe}</strong></div>
<div style="color:var(--text-3);">${isMasked(t) ? '❓ 盲測中日期隱藏' : fmtDateTime(t.entryTime, t.timeframe) + ' → ' + fmtDateTime(t.exitTime, t.timeframe)}</div>
<hr style="border-color:var(--line);margin:10px 0;">
<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px;">
  <span style="color:var(--text-3);">進場</span><span>${fmtPrice(t.entryPrice)}</span>
  <span style="color:var(--text-3);">停損 / 停利</span><span>${t.stopLoss != null ? fmtPrice(t.stopLoss) : '—'} / ${t.takeProfit != null ? fmtPrice(t.takeProfit) : '—'}</span>
  <span style="color:var(--text-3);">出場</span><span>${fmtPrice(t.exitPrice)}</span>
  <span style="color:var(--text-3);">部位</span><span>${sizeStr(t)}</span>
  <span style="color:var(--text-3);">盈虧</span><span style="color:${t.pnl >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'};font-weight:600;">${fmtMoney(t.pnl)} (${fmtR(t.rMultiple)})</span>
  <span style="color:var(--text-3);">風險</span><span>${fmtMoney(t.riskAmount)} (${t.riskPct}%)</span>
</div>
<hr style="border-color:var(--line);margin:10px 0;">
<div style="font-size:12px;">
  <div style="color:var(--text-3);margin-bottom:3px;">進場策略 / 理由</div>
  <div style="background:var(--bg-3);padding:8px 10px;border-radius:6px;">
    <div style="font-weight:600;color:var(--accent-2);margin-bottom:3px;">${escHtml(t.strategyTag)}</div>
    <div style="color:var(--text-2);">${escHtml(t.entryReason)}</div>
  </div>
</div>
<div style="font-size:12px;margin-top:8px;">
  <div style="color:var(--text-3);margin-bottom:3px;">出場原因 / 備註</div>
  <div style="background:var(--bg-3);padding:8px 10px;border-radius:6px;">
    <div style="font-weight:600;color:${t.pnl >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'};margin-bottom:3px;">${escHtml(t.exitReason)}</div>
    <div style="color:var(--text-2);">${escHtml(t.exitNote || '—')}</div>
  </div>
</div>
    </div>
  `;
  $('trade-modal').classList.add('show');
  $('btn-replay-trade').onclick = () => replayTrade(t.id);
  $('btn-delete-trade').onclick = () => {
    if (!confirm('確定刪除這筆交易紀錄？')) return;
    state.trades = state.trades.filter((x) => x.id !== t.id);
    saveStorage();
    renderTrades();
    renderReport();
    updateHotStats();
    $('trade-modal').classList.remove('show');
    showToast('已刪除', 'success');
  };
}

// ---------- 一鍵回放檢討 ----------
// 從交易紀錄跳回進場當根 K 棒（之後的走勢隱藏），重看自己當初看到什麼
let _reviewLines = [];
function clearReviewLines() {
  _reviewLines.forEach((l) => {
    try {
      candleSeries.removePriceLine(l);
    } catch {}
  });
  _reviewLines = [];
}
async function replayTrade(tradeId) {
  const t = state.trades.find((x) => x.id === tradeId);
  if (!t) return;
  if (state.blind) {
    // 盲測中只能回放本輪交易（其他標的會洩題也載不了）
    if (t.blindId !== state.blind.id) {
      showToast('盲測進行中，只能回放本輪的交易', 'error');
      return;
    }
  } else if (t.symbol !== state.symbol || t.timeframe !== state.timeframe) {
    if (!store.SYMBOLS[t.symbol]) {
      showToast('這筆交易的標的已不在清單中', 'error');
      return;
    }
    state.symbol = t.symbol;
    state.timeframe = t.timeframe;
    syncTopbarUI();
    await loadAndStart();
  }
  const idx = state.candles.findIndex((c) => c.time >= t.entryTime);
  if (idx < 0) {
    showToast('找不到該筆交易對應的 K 棒', 'error');
    return;
  }
  stopPlay();
  state.cursorIndex = state.blind ? Math.min(idx, state.blind.endIndex) : idx;
  if (state.blind) state.blind.cursorIndex = state.cursorIndex; // 續玩/重整才不會跳回原位
  saveStorage();
  renderChart();
  updateReplayInfo();
  refreshOrderForm();
  renderPositions();
  updateHotStats();
  clearReviewLines();
  _reviewLines.push(
    candleSeries.createPriceLine({
      price: t.entryPrice,
      color: '#b2b5be',
      lineWidth: 1,
      lineStyle: 3,
      title: `📍 ${t.side === 'long' ? '多' : '空'}進場 ${fmtPrice(t.entryPrice)}`,
    }),
  );
  if (t.exitPrice != null) {
    _reviewLines.push(
      candleSeries.createPriceLine({
        price: t.exitPrice,
        color: '#f7a600',
        lineWidth: 1,
        lineStyle: 3,
        title: `出場 ${fmtPrice(t.exitPrice)}（${t.exitReason || ''}）`,
      }),
    );
  }
  $('trade-modal').classList.remove('show');
  showToast('📍 已跳到進場當根——按 → 逐根重看這筆交易的發展', 'success');
}

// ---------- Report ----------
// 盲測歷史表格（給報告頁）
function renderBlindHistoryHTML() {
  if (!state.blindHistory.length) return '';
  const rows = state.blindHistory
    .slice(0, 30)
    .map((s) => {
      const info = symInfo(s.symbol);
      const wr = s.winRate == null ? '—' : s.winRate.toFixed(0) + '%';
      return `<tr>
<td>${fmtDateTime(Math.floor(s.finishedAt / 1000), '1d')}</td>
<td>${s.blownUp ? '💀 ' : ''}${escHtml(info.name)}</td>
<td class="num">${s.longs}多 / ${s.shorts}空</td>
<td class="num">${wr}</td>
<td class="num" style="color:${s.totalPnl >= 0 ? 'var(--accent-2)' : 'var(--danger-2)'}">${fmtMoney(s.totalPnl)}</td>
    </tr>`;
    })
    .join('');
  return `
    <div class="crosstab">
<h4>🎲 盲測紀錄</h4>
<table>
  <thead><tr><th>日期</th><th>標的</th><th class="num">多/空</th><th class="num">勝率</th><th class="num">盈虧</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
    </div>`;
}

function renderReport() {
  const cont = $('report-content');
  // 與交易列表同口徑：盲測中只統計本輪，否則報告會混入場外交易
  const trades = state.blind
    ? state.trades.filter((t) => t.blindId === state.blind.id)
    : state.trades;
  if (!trades.length) {
    cont.innerHTML =
      renderBlindHistoryHTML() ||
      '<div class="empty">尚無交易紀錄<br>完成幾筆模擬後彙整即會顯示</div>';
    return;
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)
    : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : Infinity;
  const avgR = trades.reduce((s, t) => s + (t.rMultiple || 0), 0) / trades.length;

  // Max consecutive losses
  let maxLossStreak = 0,
    streakSet = new Set();
  // trades are unshifted so newest first; compute over chronological order
  // 同一原始部位的分批出場算一筆（與連敗熔斷的計數口徑一致，交錯時也正確合併）
  const chrono = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of chrono) {
    if (t.pnl <= 0) {
      streakSet.add(t.parentId || t.id);
      maxLossStreak = Math.max(maxLossStreak, streakSet.size);
    } else {
      streakSet = new Set();
    }
  }

  // strategy x exitReason crosstab
  const strategies = [...new Set(trades.map((t) => t.strategyTag || '—'))].sort();
  const reasons = [...new Set(trades.map((t) => t.exitReason || '—'))].sort();
  let crosstabHTML = '';
  if (strategies.length && reasons.length) {
    crosstabHTML = `
<div class="crosstab">
  <h4>策略 × 出場原因</h4>
  <table>
    <thead><tr><th>策略</th>${reasons.map((r) => `<th class="num">${escHtml(r)}</th>`).join('')}<th class="num">合計</th></tr></thead>
    <tbody>
    ${strategies
      .map((s) => {
        let totalCount = 0;
        const cells = reasons
          .map((r) => {
            const cnt = trades.filter((t) => t.strategyTag === s && t.exitReason === r).length;
            totalCount += cnt;
            return `<td class="num">${cnt || ''}</td>`;
          })
          .join('');
        return `<tr><td>${escHtml(s)}</td>${cells}<td class="num"><strong>${totalCount}</strong></td></tr>`;
      })
      .join('')}
    </tbody>
  </table>
</div>
    `;
  }

  cont.innerHTML = `
    <div class="stat-grid">
<div class="stat-card"><div class="label">總交易數</div><div class="value">${trades.length}</div></div>
<div class="stat-card ${winRate >= 50 ? 'win' : 'lose'}"><div class="label">勝率</div><div class="value">${winRate.toFixed(1)}%</div></div>
<div class="stat-card ${totalPnl >= 0 ? 'win' : 'lose'}"><div class="label">總盈虧</div><div class="value">${fmtMoney(totalPnl)}</div></div>
<div class="stat-card ${rr >= 1 ? 'win' : 'lose'}"><div class="label">盈虧比 R:R</div><div class="value">${isFinite(rr) ? '1:' + rr.toFixed(2) : '∞'}</div></div>
<div class="stat-card"><div class="label">平均賺</div><div class="value" style="color:var(--accent-2);">${fmtMoney(avgWin)}</div></div>
<div class="stat-card"><div class="label">平均賠</div><div class="value" style="color:var(--danger-2);">${fmtMoney(avgLoss)}</div></div>
<div class="stat-card ${avgR >= 0 ? 'win' : 'lose'}"><div class="label">平均 R 倍數</div><div class="value">${fmtR(avgR)}</div></div>
<div class="stat-card lose"><div class="label">最大連虧</div><div class="value">${maxLossStreak}</div></div>
    </div>
    ${crosstabHTML}
    ${renderBlindHistoryHTML()}
    ${buildInsightHTML(trades)}
  `;
}

// 依實際交易資料生成觀察（原本是寫死的範例文字，會給出與事實相反的診斷）
function buildInsightHTML(trades) {
  if (trades.length < 5) {
    return '<div class="field-hint" style="margin-top:10px;">💡 累積 5 筆以上交易後，這裡會依你的實際紀錄整理觀察重點。</div>';
  }
  const notes = [];
  const count = (fn) => trades.filter(fn).length;
  const wins = trades.filter((t) => t.pnl > 0),
    losses = trades.filter((t) => t.pnl <= 0);
  // 1) 拗單檢查：平均虧損持有時間 vs 平均獲利持有時間
  const holdBars = (t) =>
    t.exitTime != null && t.entryTime != null && t.exitTime > t.entryTime
      ? t.exitTime - t.entryTime
      : 0;
  const avgHold = (arr) => (arr.length ? arr.reduce((s, t) => s + holdBars(t), 0) / arr.length : 0);
  const hw = avgHold(wins),
    hl = avgHold(losses);
  if (hw > 0 && hl > hw * 1.3) {
    notes.push(
      '虧損單的平均持有時間比獲利單長，是典型的「賠錢拗、賺錢跑」——檢查是不是捨不得認賠。',
    );
  } else if (hw > 0 && hw > hl * 1.3) {
    notes.push('獲利單抱得比虧損單久，抱單紀律良好，繼續保持。');
  }
  // 2) 提前出場 vs 讓停損停利執行
  const early = count((t) => /提前|不耐|扛單/.test(t.exitReason || ''));
  if (early / trades.length > 0.5) {
    notes.push(
      `${Math.round((early / trades.length) * 100)}% 的交易是提前手動出場，代表進場後常改變主意——回頭看這些單，如果不動會更好還是更糟？`,
    );
  }
  // 3) 停利距離：達停損多但達停利少
  const hitSl = count((t) => t.exitReason === '達停損'),
    hitTp = count((t) => t.exitReason === '達停利');
  if (hitSl >= 3 && hitTp === 0) {
    notes.push('停損被打到多次、停利一次都沒到，停利可能設得太遠，或進場點常在反轉前。');
  }
  // 4) 最高頻的策略 × 出場原因組合
  const combo = {};
  for (const t of trades) {
    const k = `${t.strategyTag || '—'}｜${t.exitReason || '—'}`;
    combo[k] = (combo[k] || 0) + 1;
  }
  const top = Object.entries(combo).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3 && !top[0].startsWith('—')) {
    const [tag, reason] = top[0].split('｜');
    notes.push(
      `最常出現的組合是策略「<strong>${escHtml(tag)}</strong>」→「<strong>${escHtml(reason)}</strong>」（${top[1]} 次），值得和教練一起看這組的決策過程。`,
    );
  }
  // 5) 風險一致性
  // 以母單聚合再比對：分批出場會把一個 1% 決策拆成多筆小數 riskPct，
  // 逐筆去重會把最自律的學員誤判成「風險設定亂改」
  const riskByOrder = {};
  for (const t of trades) {
    const g = t.parentId || t.id;
    riskByOrder[g] = (riskByOrder[g] || 0) + (t.riskPct || 0);
  }
  const pcts = [...new Set(Object.values(riskByOrder).map((v) => Math.round(v * 100) / 100))];
  if (pcts.length > 3) {
    notes.push(
      `每筆風險 % 用了 ${pcts.length} 種不同設定，部位大小不一致會讓勝率與期望值失真——固定風險比例是統計有效的前提。`,
    );
  }
  if (!notes.length) notes.push('目前沒有明顯的行為偏誤訊號，繼續累積樣本數。');
  return (
    `<div class="field-hint" style="margin-top:10px;">💡 依你這 ${trades.length} 筆紀錄整理的觀察：<br>` +
    notes.map((n) => `· ${n}`).join('<br>') +
    '</div>'
  );
}

// ---------- Hot stats ----------
// 帳戶權益的唯一算法：起始資金 + 已實現 + 未實現
// 抽出來是因為爆倉判定要用它：判定出局的數字必須跟畫面右上角那個「餘額」是同一個來源，
// 否則會出現「畫面明明還有錢卻被判出局」這種無法對使用者解釋的狀況
function currentEquity() {
  const balance = state.settings.balance;
  const realized = state.trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const c = state.candles[state.cursorIndex];
  let unreal = 0;
  if (c) {
    for (const p of state.positions) {
      if (p.status !== 'open') continue;
      if (p.symbol !== state.symbol || p.timeframe !== state.timeframe || !inScope(p)) continue;
      const dir = p.side === 'long' ? 1 : -1;
      unreal += (c.close - p.entryPrice) * dir * posPV(p) * p.size;
    }
  }
  return { balance, realized, unreal, total: balance + realized + unreal };
}

function updateHotStats() {
  const { realized, unreal, total } = currentEquity();
  // 畫面上顯示過有錢，爆倉判定才上膛（見 _blowUpArmed）——包含重整後第一次繪製，
  // 否則帶著浮虧部位重整進來、下一根就歸零的情境會漏判
  if (Number.isFinite(total) && total > 0) store._blowUpArmed = true;
  $('hs-balance').textContent = fmtMoney(total);
  $('hs-realized').textContent = fmtMoney(realized);
  $('hs-realized').style.color = realized >= 0 ? 'var(--accent-2)' : 'var(--danger-2)';
  $('hs-unrealized').textContent = unreal !== 0 ? fmtMoney(unreal) : '—';
  $('hs-unrealized').style.color = unreal >= 0 ? 'var(--accent-2)' : 'var(--danger-2)';
}

// ---------- Side tabs ----------
function switchSidePane(name) {
  $$('.side-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $$('.side-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'trades') renderTrades();
  if (name === 'report') renderReport();
  if (name === 'positions') renderPositions();
}

export {
  clearReviewLines,
  currentEquity,
  renderReport,
  renderTrades,
  switchSidePane,
  updateHotStats,
};
