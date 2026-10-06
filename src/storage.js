import { queueFirestoreSave } from './auth.js';
import { DEFAULT_DRAW_TEMPLATES, STORAGE_KEYS } from './constants.js';
import { state } from './state.js';

// ---------- Storage ----------
// visitor 公開模式與登入會員使用不同 localStorage namespace，避免登出後把前一位
// 會員的本機交易 / 畫線 / 盲測資料顯示給訪客。雲端同步仍只在 state.user 存在時發生。
const storageKey = (key) => (state.guestMode ? `${key}:guest` : key);

// 舊存檔缺少的新工具模板補上預設（新增工具類型時必要）
function fillMissingTemplateTypes() {
  if (!state.drawTemplates) return;
  for (const k of Object.keys(DEFAULT_DRAW_TEMPLATES)) {
    if (!Array.isArray(state.drawTemplates[k]) || !state.drawTemplates[k].length) {
      state.drawTemplates[k] = JSON.parse(JSON.stringify(DEFAULT_DRAW_TEMPLATES[k]));
    }
    if (!state.activeTplId[k]) state.activeTplId[k] = state.drawTemplates[k][0].id;
  }
}

// 指標設定合併：保留預設欄位，新指標鍵不會被舊存檔洗掉
function mergeIndicators(src) {
  if (!src) return;
  for (const key of Object.keys(state.indicators)) {
    const cur = state.indicators[key],
      inc = src[key];
    if (!inc) continue;
    if (Array.isArray(cur)) {
      if (Array.isArray(inc)) {
        for (let i = 0; i < cur.length && i < inc.length; i++) Object.assign(cur[i], inc[i]);
      }
    } else {
      Object.assign(cur, inc);
    }
  }
}

function loadStorage() {
  try {
    const t = localStorage.getItem(storageKey(STORAGE_KEYS.trades));
    if (t) {
      const j = JSON.parse(t);
      state.trades = (j.trades || []).filter((x) => x.status === 'closed');
      state.positions = (j.positions || []).filter(
        (x) => x.status === 'open' || x.status === 'pending',
      );
    }
  } catch (e) {
    console.warn('load trades fail', e);
  }
  try {
    const s = localStorage.getItem(storageKey(STORAGE_KEYS.settings));
    if (s) Object.assign(state.settings, JSON.parse(s));
  } catch (e) {
    console.warn('load settings fail', e);
  }
  try {
    const d = localStorage.getItem(storageKey(STORAGE_KEYS.drawings));
    if (d) state.drawings = JSON.parse(d) || {};
  } catch (e) {
    console.warn('load drawings fail', e);
  }
  try {
    const i = localStorage.getItem(storageKey(STORAGE_KEYS.indicators));
    if (i) {
      const parsed = JSON.parse(i);
      mergeIndicators(parsed);
    }
  } catch (e) {
    console.warn('load indicators fail', e);
  }
  // Drawing templates
  try {
    const raw = localStorage.getItem(storageKey(STORAGE_KEYS.drawTemplates));
    if (raw) {
      const parsed = JSON.parse(raw);
      state.drawTemplates = parsed.templates || JSON.parse(JSON.stringify(DEFAULT_DRAW_TEMPLATES));
      if (parsed.activeTplId) Object.assign(state.activeTplId, parsed.activeTplId);
    } else {
      state.drawTemplates = JSON.parse(JSON.stringify(DEFAULT_DRAW_TEMPLATES));
    }
  } catch (e) {
    console.warn('load templates fail', e);
    state.drawTemplates = JSON.parse(JSON.stringify(DEFAULT_DRAW_TEMPLATES));
  }
  fillMissingTemplateTypes();
  // Blind mode
  try {
    const b = localStorage.getItem(storageKey(STORAGE_KEYS.blind));
    if (b) {
      const j = JSON.parse(b);
      state.blindHistory = Array.isArray(j.history) ? j.history : [];
      state.blind = j.active || null;
    }
  } catch (e) {
    console.warn('load blind fail', e);
  }
  // Normalize legacy drawings: ensure each has a `style` object
  for (const key of Object.keys(state.drawings)) {
    for (const d of state.drawings[key]) {
      if (!d.style) {
        d.style = {
          color: d.color || '#3b82f6',
          lineWidth: d.type === 'trend' ? 2 : d.type === 'rect' ? 1.5 : 1,
          lineStyle: d.type === 'hline' ? 2 : 0,
          label: '',
        };
      }
    }
  }
}
function saveStorage() {
  try {
    localStorage.setItem(
      storageKey(STORAGE_KEYS.trades),
      JSON.stringify({
        trades: state.trades,
        positions: state.positions,
      }),
    );
    localStorage.setItem(storageKey(STORAGE_KEYS.settings), JSON.stringify(state.settings));
    // 空陣列不落地：每造訪一個標的就會留下一個空 key，長期會累積無用空殼
    const drawingsToSave = {};
    for (const [k, v] of Object.entries(state.drawings)) {
      if (Array.isArray(v) && v.length) drawingsToSave[k] = v;
    }
    localStorage.setItem(storageKey(STORAGE_KEYS.drawings), JSON.stringify(drawingsToSave));
    localStorage.setItem(storageKey(STORAGE_KEYS.indicators), JSON.stringify(state.indicators));
    if (state.drawTemplates) {
      localStorage.setItem(
        storageKey(STORAGE_KEYS.drawTemplates),
        JSON.stringify({
          templates: state.drawTemplates,
          activeTplId: state.activeTplId,
        }),
      );
    }
    localStorage.setItem(
      storageKey(STORAGE_KEYS.blind),
      JSON.stringify({
        active: state.blind,
        history: state.blindHistory,
      }),
    );
  } catch (e) {
    console.warn('save fail', e);
  }
  // Mirror to Firestore (debounced) when signed in
  queueFirestoreSave();
}

// Active template style for a tool/type
function getActiveTplStyle(toolType) {
  if (!state.drawTemplates || !state.drawTemplates[toolType]) {
    return { color: '#3b82f6', lineWidth: 1.5, lineStyle: 0, label: '' };
  }
  const tplId = state.activeTplId[toolType];
  const found =
    state.drawTemplates[toolType].find((t) => t.id === tplId) || state.drawTemplates[toolType][0];
  return found ? { ...found.style } : { color: '#3b82f6', lineWidth: 1.5, lineStyle: 0, label: '' };
}
// Convert lineStyle int → setLineDash array
function lineDashFor(ls) {
  switch (ls) {
    case 1:
      return [2, 3]; // dotted
    case 2:
      return [6, 4]; // dashed
    case 3:
      return [10, 6]; // long dashed
    case 4:
      return [2, 6]; // sparse dotted
    default:
      return []; // solid
  }
}
// 盲測時用獨立 key：舊畫線不會洩露標的、正規化座標也不污染原標的
function drawingsKey() {
  return state.blind ? `blind_${state.blind.id}` : `${state.symbol}_${state.timeframe}`;
}
function getCurrentDrawings() {
  const key = drawingsKey();
  if (!state.drawings[key]) state.drawings[key] = [];
  return state.drawings[key];
}

export {
  drawingsKey,
  fillMissingTemplateTypes,
  getActiveTplStyle,
  getCurrentDrawings,
  lineDashFor,
  loadStorage,
  mergeIndicators,
  saveStorage,
};
