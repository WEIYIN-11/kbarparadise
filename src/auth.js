import { bootApp } from './app.js';
import { enterBlindReplay } from './blind.js';
import { renderChart } from './chart.js';
import { store } from './constants.js';
import { redrawPositionLines } from './drawings.js';
import { renderPositions, updateOrderSummary } from './orders.js';
import { state } from './state.js';
import { fillMissingTemplateTypes, mergeIndicators, saveStorage } from './storage.js';
import { renderReport, renderTrades, updateHotStats } from './trades.js';
import {
  identityAllows,
  legacyPaidAccess,
  signedInIdentity,
  traderSimRequirement,
} from './tool-access.js';
import { $, showToast } from './util.js';

// ---------- Auth + Firestore sync ----------
function showLogin() {
  $('login-overlay').style.display = 'flex';
  $('app').classList.remove('ready');
}
function hideLogin() {
  $('login-overlay').style.display = 'none';
  $('app').classList.add('ready');
}

function setUser(u) {
  state.user = u;
  if (u) {
    $('user-chip').style.display = 'flex';
    $('user-avatar').src =
      u.photoURL ||
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Ccircle cx="12" cy="12" r="12" fill="%231f2937"/%3E%3Ctext x="12" y="16" text-anchor="middle" font-size="12" fill="%2394a3b8"%3E?%3C/text%3E%3C/svg%3E';
    $('user-name').textContent = u.name || u.email || '—';
  } else {
    $('user-chip').style.display = 'none';
  }
}

function isMissingToolAccessRpc(error) {
  if (!error) return false;
  if (error.code === 'PGRST202') return true;
  return /get_tool_access_settings|schema cache|could not find the function/i.test(
    error.message || '',
  );
}

async function fetchToolAccessRequirement() {
  if (!window.sb) return { ok: false, error: 'Supabase 尚未載入' };
  try {
    const { data, error } = await window.sb.rpc('get_tool_access_settings');
    if (error) {
      // 0109 / 0113 尚未套用時維持舊會員 Gate，不把 rollout 順序變成停機。
      if (isMissingToolAccessRpc(error)) return { ok: true, source: 'legacy', required: null };
      return { ok: false, error: error.message };
    }
    const required = traderSimRequirement(data);
    return required
      ? { ok: true, source: 'formal', required }
      : { ok: true, source: 'legacy', required: null };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// 會員身分仍讀方舟主站 members/admin_users，但是否能進 K 棒回放改由
// get_tool_access_settings 的 external/trader-sim 設定決定。
// 0113 尚未存在時，維持舊的「有效訂閱會員或 admin」相容 Gate。
async function fetchMembership(email, uid) {
  if (!window.sb) return { ok: false, error: 'Supabase 尚未載入' };
  try {
    const [memberRes, adminRes, toolAccess] = await Promise.all([
      window.sb
        .from('members')
        .select('tier, expires_at')
        .eq('email', email.toLowerCase())
        .maybeSingle(),
      window.sb.from('admin_users').select('role').eq('user_id', uid).maybeSingle(),
      fetchToolAccessRequirement(),
    ]);
    if (memberRes.error) return { ok: false, error: memberRes.error.message };
    if (adminRes.error) return { ok: false, error: adminRes.error.message };

    const isAdmin = !!adminRes.data;
    if (isAdmin) {
      return {
        ok: true,
        allowed: true,
        isAdmin: true,
        identity: signedInIdentity(memberRes.data),
        required: toolAccess.ok ? toolAccess.required : null,
        accessSource: toolAccess.ok ? toolAccess.source : 'admin',
      };
    }

    if (!toolAccess.ok) return toolAccess;

    const identity = signedInIdentity(memberRes.data);
    const allowed =
      toolAccess.source === 'formal'
        ? identityAllows(identity, toolAccess.required)
        : legacyPaidAccess(memberRes.data);

    return {
      ok: true,
      allowed,
      isAdmin: false,
      identity,
      required: toolAccess.required,
      accessSource: toolAccess.source,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Load full user state from Supabase (tradersim_states.state), overlay onto local
async function loadFromCloud(uid) {
  if (!window.sb) return false;
  try {
    const { data, error } = await window.sb
      .from('tradersim_states')
      .select('state')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.state) return false;
    const s = data.state;
    if (Array.isArray(s.trades)) state.trades = s.trades;
    if (Array.isArray(s.positions)) state.positions = s.positions;
    if (s.settings) Object.assign(state.settings, s.settings);
    if (s.drawings && typeof s.drawings === 'object') state.drawings = s.drawings;
    if (s.indicators) mergeIndicators(s.indicators);
    if (s.drawTemplates && typeof s.drawTemplates === 'object')
      state.drawTemplates = s.drawTemplates;
    if (s.activeTplId) Object.assign(state.activeTplId, s.activeTplId);
    fillMissingTemplateTypes();
    if (s.blind) {
      if (Array.isArray(s.blind.history)) state.blindHistory = s.blind.history;
      state.blind = s.blind.active || null;
    }
    return true;
  } catch (e) {
    console.warn('load from cloud failed:', e);
    return false;
  }
}

// 給方舟後台列表用的績效摘要（存檔當下算好，admin 不拆大 jsonb）
function makeSummary() {
  const t = state.trades;
  const wins = t.filter((x) => x.pnl > 0).length;
  return {
    trades: t.length,
    wins,
    winRate: t.length ? +((wins / t.length) * 100).toFixed(1) : null,
    totalPnl: +t.reduce((s, x) => s + (x.pnl || 0), 0).toFixed(2),
    avgR: t.length ? +(t.reduce((s, x) => s + (x.rMultiple || 0), 0) / t.length).toFixed(2) : null,
    longs: t.filter((x) => x.side === 'long').length,
    shorts: t.filter((x) => x.side === 'short').length,
    openPositions: state.positions.filter((p) => p.status === 'open').length,
    blindSessions: state.blindHistory.length,
    balance: state.settings.balance,
    lastTradeAt: t[0]?.exitTime ?? null,
  };
}

// Debounced cloud save
let _cloudSaveTimer = null;
function queueFirestoreSave() {
  // 名稱保留（saveStorage 呼叫點多），實作已換 Supabase
  if (!state.user || !window.sb) return;
  clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(() => {
    actualCloudSave().catch((e) => console.warn('cloud save failed:', e));
  }, 1500);
}
async function actualCloudSave() {
  if (!state.user || !window.sb) return;
  const { error } = await window.sb.from('tradersim_states').upsert({
    user_id: state.user.uid,
    email: state.user.email,
    display_name: state.user.name || null,
    state: {
      trades: state.trades,
      positions: state.positions,
      settings: state.settings,
      drawings: state.drawings,
      indicators: state.indicators,
      drawTemplates: state.drawTemplates,
      activeTplId: state.activeTplId,
      blind: { active: state.blind, history: state.blindHistory },
    },
    summary: makeSummary(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// Login flow（方舟藍圖同一套 Supabase 帳號）
async function doGoogleSignIn() {
  if (!window.sb) {
    showLoginError('系統還在載入，請稍後再試');
    return;
  }
  $('login-error').classList.remove('show');
  $('btn-google').disabled = true;
  // 被非會員攔截過才強制跳帳號選擇器：一般會員不用多按一次，
  // 但「用錯 Google 帳號」的人不會被 Google 靜默丟回同一個帳號
  const opts = { redirectTo: location.origin };
  if (getForceChooser()) opts.queryParams = { prompt: 'select_account' };
  const { error } = await window.sb.auth.signInWithOAuth({
    provider: 'google',
    options: opts,
  });
  // 成功會整頁跳轉到 Google；只有失敗會走到這裡
  if (error) {
    showLoginError('登入失敗：' + error.message);
    $('btn-google').disabled = false;
  }
}
async function sendMagicLink() {
  if (!window.sb) {
    showLoginError('系統還在載入，請稍後再試');
    return;
  }
  const email = $('login-email').value.trim();
  if (!email || !email.includes('@')) {
    showLoginError('請輸入正確的 Email');
    return;
  }
  $('login-error').classList.remove('show');
  $('btn-magiclink').disabled = true;
  $('btn-magiclink').textContent = '寄送中…';
  const { error } = await window.sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin },
  });
  if (error) {
    showLoginError('寄送失敗：' + error.message);
    $('btn-magiclink').disabled = false;
    $('btn-magiclink').textContent = '寄送登入連結';
  } else {
    $('btn-magiclink').textContent = '✓ 已寄出，請到信箱點連結';
  }
}
// 權限不足時回主站方案頁。金流尚未開放，不回接舊 Skool checkout。
const PLANS_URL = 'https://ark-blueprint.com/plans';
const CHOOSER_KEY = 'tradersim.forceChooser';

// 「下次 Google 登入強制跳帳號選擇器」的旗標。放 sessionStorage 而不是記憶體：
// 攔截卡本身就會把人整頁送去 Skool，記憶體變數活不過那一趟，
// 使用者按上一頁回來又會被 Google 靜默丟回同一個錯帳號，原地打轉。
function setForceChooser(on) {
  try {
    on ? sessionStorage.setItem(CHOOSER_KEY, '1') : sessionStorage.removeItem(CHOOSER_KEY);
  } catch {}
}
function getForceChooser() {
  try {
    return sessionStorage.getItem(CHOOSER_KEY) === '1';
  } catch {
    return false;
  }
}

function showNotMember(email, message = '這個帳號目前沒有 K 棒回放使用權限。') {
  // overlay 可能已被 hideLogin() 藏起來（App 正在用，另一個帳號的 auth 事件飄進來），
  // 不先叫出來攔截卡會顯示在看不見的地方。
  showLogin();
  setForceChooser(true);
  $('nomember-email').textContent = email || '（未取得 Email）';
  $('nomember-message').textContent = message;
  $('login-error').classList.remove('show');
  $('login-card').style.display = 'none';
  $('nomember-card').style.display = 'block';
  // 不自動倒數跳轉：自動跳走過去出過「隱形倒數把人踢走」「跨分頁踢走已
  // 登入會員」兩個嚴重 bug，改成使用者自己按「去加入會員」才離開。
  $('nomember-count').textContent = '';
}
async function goPlans() {
  $('nomember-count').textContent = '前往中…';
  // 登出是非同步的（先打 /logout 再清 localStorage）。導頁若搶在它前面，
  // token 會殘留，使用者回來又被自動攔截一次。等它，但最多等 600ms。
  if (store._signOutPromise) {
    try {
      await Promise.race([store._signOutPromise, new Promise((r) => setTimeout(r, 600))]);
    } catch {}
  }
  location.href = PLANS_URL;
}
function backToLogin() {
  $('nomember-count').textContent = '';
  $('nomember-card').style.display = 'none';
  $('login-card').style.display = 'block';
  $('btn-google').disabled = false;
  // magic link 按鈕成功後會停在 disabled 的「✓ 已寄出」，回到登入卡若不還原，
  // 使用者沒辦法改用另一個 Email 重寄，畫面還在說信寄出去了
  $('btn-magiclink').disabled = false;
  $('btn-magiclink').textContent = '寄送登入連結';
}
function showLoginError(msg) {
  const errEl = $('login-error');
  errEl.textContent = msg;
  errEl.classList.add('show');
}
async function doSignOut() {
  if (window.sb) {
    try {
      await window.sb.auth.signOut();
    } catch {}
  }
  state.user = null;
  setUser(null);
  location.reload();
}

let _appBooted = false;
let _handledUid = null;
async function handleAuthSuccess(sbUser) {
  if (_handledUid === sbUser.id) return; // token refresh 等事件重複觸發時跳過
  _handledUid = sbUser.id;
  // 沒有 email 就無從比對訂閱（fetchMembership 會在 email.toLowerCase() 直接 throw，
  // 被吃成「連線異常」把 TypeError 噴到畫面上）。當成非會員擋下才是對的。
  if (!sbUser.email) {
    _handledUid = null;
    showNotMember('');
    store._signOutPromise = window.sb.auth.signOut().catch(() => {});
    return;
  }
  // 會員資格檢查（= 白名單同步方舟訂閱會員）
  const m = await fetchMembership(sbUser.email, sbUser.id);
  if (!m.ok) {
    _handledUid = null;
    backToLogin();
    showLoginError('連線異常，請重新整理再試（' + m.error + '）');
    return;
  }
  if (!m.allowed) {
    _handledUid = null;
    const message =
      m.accessSource === 'formal' && m.required === 'vip'
        ? '這個工具目前需要 VIP 權限。'
        : m.accessSource === 'formal' && m.required === 'member'
          ? '這個工具目前需要登入一般會員。'
          : '這個帳號目前沒有舊制 K 棒回放使用權限。';
    showNotMember(sbUser.email, message);
    // 不 await：登出走網路，不能讓攔截畫面卡在轉圈。goPlans() 會在導頁前補等一下。
    store._signOutPromise = window.sb.auth.signOut().catch(() => {});
    return;
  }
  // 走到這裡＝有效會員。若這一輪曾顯示過攔截卡（例如跨分頁先被錯帳號擋過），
  // 先把兩張卡還原，之後 overlay 再顯示時才不會是一張空白/錯誤的卡。
  backToLogin();
  setForceChooser(false);
  const meta = sbUser.user_metadata || {};
  setUser({
    uid: sbUser.id,
    email: sbUser.email,
    name: meta.name || meta.full_name || (sbUser.email ? sbUser.email.split('@')[0] : '會員'),
    photoURL: meta.avatar_url || meta.picture || null,
    isAdmin: m.isAdmin,
  });
  // Pull cloud data (if any) — overlays onto local
  await loadFromCloud(sbUser.id);
  // Persist merged state to localStorage too（也會 queue 一次雲端存檔：本地舊資料自動上雲）
  saveStorage();
  hideLogin();
  if (!_appBooted) {
    await bootApp();
    _appBooted = true;
  } else if (state.blind && store.SYMBOLS[state.blind.symbol]) {
    // 雲端還原了進行中的盲測
    await enterBlindReplay();
  } else {
    // Re-render
    if (state.candles?.length) renderChart();
    renderPositions();
    renderTrades();
    renderReport();
    updateHotStats();
  }
}

async function handleSignedOutAccess() {
  _handledUid = null;
  const access = await fetchToolAccessRequirement();
  if (!access.ok) {
    showLogin();
    showLoginError('權限設定暫時無法確認，請重新整理再試（' + access.error + '）');
    return;
  }

  // 0113 尚未上線或目前最低權限不是 visitor → 保留登入 Gate。
  if (access.source !== 'formal' || access.required !== 'visitor') {
    showLogin();
    return;
  }

  // 公開模式必須和會員本機資料隔離。storage.js 會使用 guest namespace。
  state.guestMode = true;
  setUser(null);
  hideLogin();
  if (!_appBooted) {
    await bootApp();
    _appBooted = true;
  }
}

function setupAuthListener() {
  if (!window.sb) return;
  window.sb.auth.onAuthStateChange((event, session) => {
    if (session && session.user) {
      state.guestMode = false;
      // 歸屬上報早於會員檢查：非會員新註冊者也要留下歸屬，他日後付費時
      // 推薦人才算數。fire-and-forget，不擋登入。
      if (window.arkReportReferral) window.arkReportReferral();
      // 登入成功 / 頁面重整已有 session / magic link 回跳 — 都走會員檢查 + 載入
      handleAuthSuccess(session.user);
      return;
    }

    if (event === 'SIGNED_OUT' && _appBooted) {
      // 已載入過會員資料的分頁先整頁重啟，再決定能否以 visitor 模式進入；
      // 避免同一個 JS state 把上一位會員的本機交易顯示給訪客。
      location.reload();
      return;
    }
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') {
      handleSignedOutAccess();
    }
  });
}

// ---------- Settings actions ----------
function saveSettingsAction() {
  const b = +$('set-balance').value;
  if (!b || b < 1000) {
    showToast('餘額至少 1000', 'error');
    return;
  }
  state.settings.balance = b;
  saveStorage();
  updateOrderSummary();
  updateHotStats();
  showToast('已儲存', 'success');
}
function exportJson() {
  // 盲測進行中：匯出檔要遮掉本輪的標的與日期，否則等於直接看答案
  // 盲測進行中的紀錄：除了標的與時間，pv（點值快照）也要遮——
  // pv = 原始點值 ÷ scale，洩漏它等於洩漏正規化倍率，可直接反推真實價位
  const mask = (x) =>
    state.blind && x.blindId === state.blind.id
      ? {
          ...x,
          symbol: '❓盲測進行中',
          entryTime: null,
          exitTime: null,
          chartTime: null,
          createdBarTime: null,
          pv: null,
        }
      : x;
  const payload = {
    exportedAt: new Date().toISOString(),
    user: state.user ? { name: state.user.name, email: state.user.email } : { name: '訪客' },
    settings: state.settings,
    openPositions: state.positions.map(mask),
    closedTrades: state.trades.map(mask),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `練功房_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已下載 JSON', 'success');
}
function clearAll() {
  if (!confirm('確定清除所有模擬紀錄？此動作無法復原。')) return;
  state.trades = [];
  state.positions = [];
  saveStorage();
  renderPositions();
  renderTrades();
  renderReport();
  updateHotStats();
  redrawPositionLines();
  showToast('已清除全部', 'success');
}

// ============================================================

export {
  backToLogin,
  clearAll,
  doGoogleSignIn,
  doSignOut,
  exportJson,
  goPlans,
  hideLogin,
  queueFirestoreSave,
  saveSettingsAction,
  sendMagicLink,
  setForceChooser,
  setupAuthListener,
  showLogin,
  showNotMember,
};
