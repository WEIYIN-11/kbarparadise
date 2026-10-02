// UMD 版掛在 window.supabase；上面兩支是傳統 script，module 執行時必定已載入
const { createClient } = window.supabase;

const SUPABASE_URL = 'https://bvmeeupxhbrwtrmuyhqq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_yVqoWtwJN3QKnEW_f9_sLg_zci7fNbk';

// ---- 跨子網域共用 session — 協定 v1（正本在主站 src/lib/authStorage.mjs）----
// supabase-js 預設存 localStorage，而 localStorage 綁單一 origin，所以主站
// 登入過來這裡還是要再登一次。改存 Domain=.ark-blueprint.com 的 cookie 後
// 四站（主站 / sim / health / growth）共用同一份 session。
// 四份實作，改規格要四處同改。
const AUTH_ROOT_DOMAIN = 'ark-blueprint.com';
const AUTH_CHUNK_SIZE = 3600; // 單顆 cookie 上限約 4096，留約 400 給名稱與屬性
const AUTH_MAX_CHUNKS = 12; // 3600×12 ≈ 43KB，遠大於實際 session（實測約 3.8KB）
const AUTH_MAX_AGE = 400 * 24 * 60 * 60; // 瀏覽器對 cookie 壽命的硬上限
// 「這個瀏覽器已從 localStorage 遷移過」的共用記號。四站各有一份改版前的
// localStorage，登出只清得掉當下這站；沒有它的話主站登出後一進 sim 就會
// 被 sim 那份舊的寫回共用 cookie，四站一起復活。所以登出刻意不清它。
const AUTH_MIGRATED_SUFFIX = '.m';
// 線上加 __Secure- 前綴：這種 cookie 只能從 https 設定，擋掉中間人在某個
// http:// 子網域種同名 cookie 蓋過我們的。ark-blueprint.com 不在瀏覽器的
// HSTS preload 清單裡，首次造訪沒有保護，所以不能只靠 HSTS。
const AUTH_SECURE_PREFIX = '__Secure-';
const authFallbackKey = (key) => `${key}.fallback`;

const authCookieDomain = () => {
  const h = location.hostname.toLowerCase();
  return h === AUTH_ROOT_DOMAIN || h.endsWith('.' + AUTH_ROOT_DOMAIN)
    ? '.' + AUTH_ROOT_DOMAIN
    : null; // 本機 dev / 預覽網域 → host-only
};
const authIsSecure = () => location.protocol === 'https:';
// 本機 dev 走 http，加了前綴就寫不進去
const authBaseName = (key) => (authIsSecure() ? AUTH_SECURE_PREFIX + key : key);

const buildAuthCookie = (name, value, maxAge, domain) => {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Lax'];
  if (domain) parts.push(`Domain=${domain}`);
  if (authIsSecure()) parts.push('Secure');
  return parts.join('; ');
};

const authJar = () => {
  const jar = new Map();
  for (const part of String(document.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
};

// 片數對不上（中間被瀏覽器依配額驅逐，或殘留讀不到的尾巴）一律回 null：
// session 沒有「讀一半還能用」這種事，殘片壓過備援會變成登不進去的迴圈。
const readChunkedAuth = (base) => {
  const jar = authJar();
  const prefix = base + '.';
  let present = 0;
  for (const name of jar.keys()) {
    if (name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))) present++;
  }
  if (present === 0) return null;
  let encoded = '',
    read = 0;
  for (let i = 0; i < AUTH_MAX_CHUNKS; i++) {
    const piece = jar.get(`${prefix}${i}`);
    if (piece === undefined) break;
    encoded += piece;
    read++;
  }
  if (read !== present) return null;
  try {
    return decodeURIComponent(encoded);
  } catch (e) {
    return null;
  }
};

const clearAuthChunks = (key) => {
  const d = authCookieDomain();
  const base = authBaseName(key);
  for (let i = 0; i < AUTH_MAX_CHUNKS; i++) {
    document.cookie = buildAuthCookie(`${base}.${i}`, '', 0, d);
    // 同名但 host-only 的是另一顆 cookie，帶 Domain 的刪除指令碰不到，
    // 留著會蓋過我們自己這顆 → 多發一次不帶 Domain 的刪除掃掉它。
    if (d) document.cookie = buildAuthCookie(`${base}.${i}`, '', 0, null);
  }
};

const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch (e) {
    /* noop */
  }
};
const lsDel = (k) => {
  try {
    localStorage.removeItem(k);
  } catch (e) {
    /* noop */
  }
};

const setAuthItem = (key, value) => {
  // 先清乾淨：新值片數變少時，殘留的舊尾巴會被下次讀取串進來變成壞 JSON
  clearAuthChunks(key);
  const encoded = encodeURIComponent(value);
  const chunks = [];
  for (let i = 0; i < encoded.length; i += AUTH_CHUNK_SIZE) {
    chunks.push(encoded.slice(i, i + AUTH_CHUNK_SIZE));
  }
  if (!chunks.length) chunks.push('');
  const d = authCookieDomain();
  const base = authBaseName(key);
  // 超過上限就整批別寫：多出來的尾巴既讀不回來也清不掉（兩邊都只跑
  // AUTH_MAX_CHUNKS 圈），會帶著 token 永久留在共用網域上。
  if (chunks.length <= AUTH_MAX_CHUNKS) {
    chunks.forEach((piece, i) => {
      document.cookie = buildAuthCookie(`${base}.${i}`, piece, AUTH_MAX_AGE, d);
    });
  }
  if (readChunkedAuth(base) === value) {
    document.cookie = buildAuthCookie(base + AUTH_MIGRATED_SUFFIX, '1', AUTH_MAX_AGE, d);
    lsDel(key);
    lsDel(authFallbackKey(key));
    return;
  }
  // 只寫進去一部分（配額或顆數上限）。殘片讀得到但不完整，會壓過下面這份
  // 正確的備援 → 使用者卡在永遠登不進去的迴圈，自己清不掉。
  clearAuthChunks(key);
  lsSet(authFallbackKey(key), value);
};

const sharedAuthStorage = {
  getItem(key) {
    const base = authBaseName(key);
    const fromCookie = readChunkedAuth(base);
    if (fromCookie !== null) return fromCookie;

    // cookie 完全不通時新碼自己存的備援，優先於改版前留下的舊值
    const fallback = lsGet(authFallbackKey(key));
    if (fallback !== null) return fallback;

    // 已遷移過 → localStorage 那份必定是改版前的舊值，撿了就是登出無效
    if (authJar().has(base + AUTH_MIGRATED_SUFFIX)) {
      lsDel(key);
      return null;
    }

    // 改版前登入的人 session 還在 localStorage，接手過來免得被踢出去
    const legacy = lsGet(key);
    if (legacy !== null) setAuthItem(key, legacy);
    return legacy;
  },
  setItem: setAuthItem,
  removeItem(key) {
    clearAuthChunks(key); // marker 刻意不清，清了等於重開「舊值復活」那個洞
    lsDel(key);
    lsDel(authFallbackKey(key));
  },
};

window.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // magic link / OAuth 回跳自動處理
    storage: sharedAuthStorage, // 見上方協定；主站登入後這裡不必再登一次
  },
});

// ---- 全站推薦連結 — 協定 v1（正本在主站 src/lib/referral.mjs）----
// cookie ark_ref / Domain=.ark-blueprint.com / 90 天 / first-touch。
// 五個入口各一份實作，改規格要五處同改。
const REF_COOKIE = 'ark_ref';
const REF_MAX_AGE = 60 * 60 * 24 * 90;
const ROOT_DOMAIN = 'ark-blueprint.com';

const normRef = (raw) => {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,39}$/.test(v) ? v : null;
};
const refDomain = () => {
  const h = location.hostname.toLowerCase();
  return h === ROOT_DOMAIN || h.endsWith('.' + ROOT_DOMAIN) ? '.' + ROOT_DOMAIN : null;
};
const readRef = () => {
  for (const chunk of document.cookie.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq < 0 || chunk.slice(0, eq).trim() !== REF_COOKIE) continue;
    try {
      const v = normRef(decodeURIComponent(chunk.slice(eq + 1).trim()));
      if (v) return v;
    } catch (e) {
      /* 壞值當作沒有 */
    }
  }
  try {
    return normRef(localStorage.getItem(REF_COOKIE));
  } catch (e) {
    return null;
  }
};
const clearRef = () => {
  const d = refDomain();
  try {
    const parts = [REF_COOKIE + '=', 'Path=/', 'Max-Age=0'];
    if (d) parts.push('Domain=' + d);
    document.cookie = parts.join('; ');
  } catch (e) {
    /* noop */
  }
  try {
    localStorage.removeItem(REF_COOKIE);
  } catch (e) {
    /* noop */
  }
};

// 落地即捕捉（first-touch：已有值不覆寫）
try {
  const code = normRef(new URLSearchParams(location.search).get('ref'));
  if (code && !readRef()) {
    const d = refDomain();
    const parts = [
      REF_COOKIE + '=' + encodeURIComponent(code),
      'Path=/',
      'Max-Age=' + REF_MAX_AGE,
      'SameSite=Lax',
    ];
    if (d) parts.push('Domain=' + d);
    if (location.protocol === 'https:') parts.push('Secure');
    try {
      document.cookie = parts.join('; ');
    } catch (e) {
      /* cookie 被封鎖 */
    }
    try {
      localStorage.setItem(REF_COOKIE, code);
    } catch (e) {
      /* 放棄 */
    }
  }
} catch (e) {
  /* 捕捉失敗不影響練功房本身 */
}

// 有 session 時上報歸屬。fire-and-forget，任何失敗都不擋登入。
// 'ineligible' 不清 cookie — 連結可能是在別人已登入的瀏覽器被打開。
const refAttempted = new Set();
window.arkReportReferral = async function () {
  const code = readRef();
  if (!code || refAttempted.has(code) || !window.sb) return;
  refAttempted.add(code);
  try {
    const { data, error } = await window.sb.rpc('crm_report_my_referral', {
      p: { ref_code: code, landing_app: 'sim' },
    });
    if (error) {
      refAttempted.delete(code);
      return;
    }
    if (data === 'recorded' || data === 'already') clearRef();
  } catch (e) {
    refAttempted.delete(code);
  }
};

// Notify the main script that Supabase is ready
window.dispatchEvent(new Event('supabase-ready'));
