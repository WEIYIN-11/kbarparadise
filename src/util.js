// ---------- Util ----------
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const fmtMoney = (n) => {
  if (n == null || isNaN(n)) return '—';
  const s = Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
  return (n < 0 ? '-$' : '$') + Math.abs(+s).toLocaleString();
};
// 價格小數位自適應：高價 2 位，低價幣（SHIB/PEPE 等）取夠多有效位數
const priceDp = (p) => {
  if (!isFinite(p) || p <= 0) return 2;
  if (p >= 20) return 2;
  if (p >= 1) return 3;
  return Math.min(10, Math.ceil(-Math.log10(p)) + 3);
};
const fmtPrice = (n) => {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(priceDp(Math.abs(n)));
};
const fmtPct = (n) => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%');
const fmtR = (n) => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + 'R');
const escHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtDateTime = (ts, tf) => {
  const d = new Date(ts * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (tf === '1d') return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
};
function showToast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = '';
  void t.offsetWidth; // restart anim
  t.classList.add('show');
  if (kind) t.classList.add(kind);
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2200);
}

export { $, $$, escHtml, fmtDateTime, fmtMoney, fmtPrice, fmtR, priceDp, showToast, uid };
