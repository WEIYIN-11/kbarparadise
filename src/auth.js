import { bootApp } from './app.js';
import { enterBlindReplay } from './blind.js';
import { renderChart } from './chart.js';
import { store } from './constants.js';
import { redrawPositionLines } from './drawings.js';
import { renderPositions, updateOrderSummary } from './orders.js';
import { state } from './state.js';
import { fillMissingTemplateTypes, mergeIndicators, saveStorage } from './storage.js';
import { renderReport, renderTrades, updateHotStats } from './trades.js';
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

// 會員資格判定：與方舟主站同一套有效期限規則。
const PAID_TIERS = ['starter', 'vip', 'pro', 'private'];
const VIP_TIERS = ['vip', 'pro', 'private'];
const TOOL_ACCESS_KEY = 'trader-sim';
// 中央設定讀不到時的門檻。2026-10-06 由站主決定改為 member（有方舟藍圖帳號即可用）：
// 中央設定所需的 migration 0109/0113 尚未套用到正式資料庫，後台切換存不進去，
// 這段期間一律走這個預設值。member 仍要求登入，所以最多只開放給方舟帳號，不會變成免登入。
// ⚠ 0113 套上正式環境那一刻，trader-sim 的種子值是 legacy_paid，會立刻蓋過這裡、
//   變回只限付費會員——屆時要同時到主站後台 /admin/tiers 把「K 棒回放」設為「一般會員」。
const TOOL_ACCESS_FALLBACK = 'member';

let _toolAccessPromise = null;

async function fetchToolAccessRequirement() {
  if (!window.sb) return TOOL_ACCESS_FALLBACK;
  try {
    const { data, error } = await window.sb.rpc('get_tool_access_settings');
    if (error || !data || typeof data !== 'object' || !Array.isArray(data.settings)) {
      return TOOL_ACCESS_FALLBACK;
    }
    const row = data.settings.find(
      (item) => item && item.surface === 'external' && item.toolKey === TOOL_ACCESS_KEY,
    );
    const requirement = row?.minIdentity;
    return ['visitor', 'member', 'vip', 'legacy_paid', 'disabled'].includes(requirement)
      ? requirement
      : TOOL_ACCESS_FALLBACK;
  } catch {
    return TOOL_ACCESS_FALLBACK;
  }
}

// 登入卡上「誰可以用」那句話跟著實際門檻走。HTML 不寫死：寫死的話門檻一改，
// 畫面就會說謊（例如開放給一般會員後還寫「僅限有效訂閱會員」，把人勸退）。
// 門檻查出來之前先留空，寧可晚一點出現，也不要先閃一句錯的。
const ACCESS_NOTES = {
  member: '還沒有帳號？直接用 Google 或 Email 註冊即可',
  vip: '僅限 VIP 會員使用；尚未加入請先至 ark-blueprint.com',
  legacy_paid: '僅限有效訂閱會員使用；尚未訂閱請先至 ark-blueprint.com',
  disabled: '練功房目前暫停開放',
};

function getToolAccessRequirement() {
  if (!_toolAccessPromise) {
    _toolAccessPromise = fetchToolAccessRequirement().then((requirement) => {
      // 用 ?. ：這個 promise 會被快取給整個登入流程用，萬一欄位被改名/刪掉，
      // 這裡 throw 會讓所有人卡在登入。文案缺一句可以接受，登入壞掉不行。
      const note = $('login-access-note');
      if (note) note.textContent = ACCESS_NOTES[requirement] || '';
      return requirement;
    });
  }
  return _toolAccessPromise;
}

function toolRequirementAllows(requirement, input) {
  if (input.isAdmin) return true;
  if (requirement === 'disabled') return false;
  if (requirement === 'visitor') return true;
  if (!input.authenticated) return false;
  if (requirement === 'member') return true;
  if (requirement === 'legacy_paid') return PAID_TIERS.includes(input.tier);
  return VIP_TIERS.includes(input.tier);
}

async function fetchMembership(email, uid) {
  if (!window.sb) return { ok: false, error: 'Supabase 尚未載入' };
  try {
    const [memberRes, adminRes] = await Promise.all([
      window.sb
        .from('members')
        .select('tier, expires_at')
        .eq('email', email.toLowerCase())
        .maybeSingle(),
      window.sb.from('admin_users').select('role').eq('user_id', uid).maybeSingle(),
    ]);
    if (memberRes.error) return { ok: false, error: memberRes.error.message };
    if (adminRes.error) return { ok: false, error: adminRes.error.message };

    let tier = null;
    if (memberRes.data) {
      const exp = memberRes.data.expires_at;
      if (!exp || new Date(exp).getTime() >= Date.now()) {
        tier = memberRes.data.tier;
      }
    }
    const isAdmin = !!adminRes.data;
    return {
      ok: true,
      isAdmin,
      tier,
      allowed: isAdmin || PAID_TIERS.includes(tier),
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
// 非會員攔截：不是丟一行紅字就算了，導去 Skool 付費頁
const PLANS_URL = 'https://www.skool.com/blue-print/about';
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

function showNotMember(email) {
  // overlay 可能已被 hideLogin() 藏起來（App 正在用，另一個帳號的 auth 事件飄進來），
  // 不先叫出來攔截卡會顯示在看不見的地方。
  showLogin();
  setForceChooser(true);
  $('nomember-email').textContent = email || '（未取得 Email）';
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

async function enterGuestMode() {
  state.guestMode = true;
  setUser(null);
  backToLogin();
  hideLogin();
  if (!_appBooted) {
    await bootApp();
    _appBooted = true;
  }
}

async function renderSignedInApp(sbUser, isAdmin) {
  state.guestMode = false;
  backToLogin();
  setForceChooser(false);
  const meta = sbUser.user_metadata || {};
  setUser({
    uid: sbUser.id,
    email: sbUser.email,
    name: meta.name || meta.full_name || (sbUser.email ? sbUser.email.split('@')[0] : '會員'),
    photoURL: meta.avatar_url || meta.picture || null,
    isAdmin,
  });
  await loadFromCloud(sbUser.id);
  saveStorage();
  hideLogin();
  if (!_appBooted) {
    await bootApp();
    _appBooted = true;
  } else if (state.blind && store.SYMBOLS[state.blind.symbol]) {
    await enterBlindReplay();
  } else {
    if (state.candles?.length) renderChart();
    renderPositions();
    renderTrades();
    renderReport();
    updateHotStats();
  }
}

async function handleAuthSuccess(sbUser) {
  if (_handledUid === sbUser.id) return;
  _handledUid = sbUser.id;
  const requirement = await getToolAccessRequirement();

  if (window.arkReportReferral) window.arkReportReferral();

  // 公開模式允許無 email 帳號退回純訪客；其他模式需要可識別帳號。
  if (!sbUser.email) {
    _handledUid = null;
    if (requirement === 'visitor') {
      await enterGuestMode();
      return;
    }
    showNotMember('');
    return;
  }

  if (requirement === 'visitor' || requirement === 'member') {
    await renderSignedInApp(sbUser, false);
    return;
  }

  const m = await fetchMembership(sbUser.email, sbUser.id);
  if (!m.ok) {
    _handledUid = null;
    backToLogin();
    showLoginError('連線異常，請重新整理再試（' + m.error + '）');
    return;
  }
  if (
    !toolRequirementAllows(requirement, {
      authenticated: true,
      isAdmin: m.isAdmin,
      tier: m.tier,
    })
  ) {
    _handledUid = null;
    showNotMember(sbUser.email);
    return;
  }

  await renderSignedInApp(sbUser, m.isAdmin);
}

function setupAuthListener() {
  if (!window.sb) return;

  void (async () => {
    const requirement = await getToolAccessRequirement();
    const { data, error } = await window.sb.auth.getSession();
    if (error) {
      showLoginError('登入狀態讀取失敗，請重新整理再試');
      return;
    }
    if (data.session?.user) {
      await handleAuthSuccess(data.session.user);
    } else if (requirement === 'visitor') {
      await enterGuestMode();
    } else {
      showLogin();
    }
  })();

  window.sb.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      void handleAuthSuccess(session.user);
      return;
    }
    _handledUid = null;
    void getToolAccessRequirement().then((requirement) => {
      if (requirement === 'visitor') void enterGuestMode();
      else showLogin();
    });
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
