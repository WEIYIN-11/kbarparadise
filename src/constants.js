import { state } from './state.js';

// ============================================================
// 練功房 - 主程式
// ============================================================

// ---------- Constants ----------
// 標的註冊表：正式清單由 data/symbols.json 載入（fetch-data.mjs 產出），
// 這裡只放載入失敗時的內建保底三檔。pointValue = 每 1 點對應 USD。
const TWD_USD = 31;
const BUILTIN_SYMBOLS = {
  NQ: {
    key: 'NQ',
    name: 'NQ 那斯達克100期貨',
    category: 'futures',
    pointValue: 20,
    sizeUnit: '口',
    sizeDecimals: 2,
    tfs: ['1d', '1h'],
  },
  BTC: {
    key: 'BTC',
    name: 'BTC 比特幣',
    category: 'crypto',
    pointValue: 1,
    sizeUnit: '顆',
    sizeDecimals: 4,
    tfs: ['1d', '1h'],
  },
  TXF: {
    key: 'TXF',
    name: 'TXF 台指期',
    category: 'futures',
    pointValue: 200 / TWD_USD,
    sizeUnit: '口',
    sizeDecimals: 2,
    tfs: ['1d', '1h'],
  },
};
// 會被多個區塊重新賦值的共享狀態。拆成模組之後 import 進來的是唯讀綁定，
// 不能直接 X = v，所以集中成一個物件用 store.X 存取；誰在改共享狀態也因此
// 一眼看得出來。只放「跨區塊被改寫」的，單一區塊內部自己用的仍留在原地。
const store = {
  SYMBOLS: { ...BUILTIN_SYMBOLS },
  CATEGORY_LABELS: { futures: '期指', crypto: '加密貨幣', us: '美股', tw: '台股' },
  // 持倉在圖表上的價格線（每次重畫重建）
  posLines: [],
  // 圖表下單工具正在拖曳的把手：'entry' | 'sl' | 'tp'
  posToolDrag: null,
  // 平倉視窗正對著哪個部位，以及平倉比例（分批出場）
  _closeTargetId: null,
  _closeFrac: 1,
  // 「這輪曾經有錢」：權益是全域的（起始資金 + 全部已實現），一輪把錢燒光之後，
  // 下一輪開場的權益還是負的。少了這個閂，每開一輪新盲測都會在第一根 K 棒被判出局。
  // 所以只在「看過 > 0 才跌到 <= 0」時宣告；權益重新回正才重新上膛。
  _blowUpArmed: false,
  // 登出的 promise：導向付費頁前要等它(最多 600ms)，否則 token 會殘留
  _signOutPromise: null,
};

function symInfo(sym) {
  return (
    store.SYMBOLS[sym] || {
      key: sym,
      name: sym,
      category: '',
      pointValue: 1,
      sizeUnit: '',
      sizeDecimals: 2,
      tfs: ['1d'],
    }
  );
}
// 下單當下的有效點值：盲測時價格被正規化（×scale），點值同步 ÷scale，金額不變
function getPointValue(sym) {
  const pv = symInfo(sym).pointValue;
  return state.blind && sym === state.blind.symbol ? pv / state.blind.scale : pv;
}
// 部位/交易計算盈虧用的點值：優先用建倉時快照（盲測倉位必須用快照才正確）
function posPV(p) {
  return p.pv ?? symInfo(p.symbol).pointValue;
}
function sizeStr(p) {
  const info = symInfo(p.symbol);
  return p.size.toFixed(info.sizeDecimals) + (info.sizeUnit ? ' ' + info.sizeUnit : '');
}
// 盲測遮罩：進行中的盲測交易不顯示真實標的名稱
function isMasked(p) {
  return !!(state.blind && p.blindId === state.blind.id);
}
function dispSym(p) {
  return isMasked(p) ? '❓❓' : p.symbol;
}
function symLabel(sym) {
  if (state.blind && sym === state.blind.symbol) return '❓ 盲測標的';
  return symInfo(sym).name;
}
// 盲測 scope：盲測中只操作盲測部位；平時只操作一般部位（避免互相觸發）
function inScope(p) {
  return (p.blindId || null) === (state.blind ? state.blind.id : null);
}

const STORAGE_KEYS = {
  trades: 'tradersim_trades_v1',
  settings: 'tradersim_settings_v1',
  drawings: 'tradersim_drawings_v1',
  indicators: 'tradersim_indicators_v1',
  drawTemplates: 'tradersim_draw_templates_v1',
  blind: 'tradersim_blind_v1',
};

// Default templates per tool (TradingView-like presets)
const DEFAULT_DRAW_TEMPLATES = {
  trend: [
    {
      id: 'tpl-trend-default',
      name: '預設',
      style: { color: '#3b82f6', lineWidth: 2, lineStyle: 0, label: '' },
    },
    {
      id: 'tpl-trend-support',
      name: '支撐線',
      style: { color: '#089981', lineWidth: 3, lineStyle: 0, label: '支撐' },
    },
    {
      id: 'tpl-trend-resist',
      name: '壓力線',
      style: { color: '#f23645', lineWidth: 3, lineStyle: 0, label: '壓力' },
    },
    {
      id: 'tpl-trend-channel',
      name: '通道',
      style: { color: '#a855f7', lineWidth: 1.5, lineStyle: 2, label: '' },
    },
  ],
  hline: [
    {
      id: 'tpl-hline-default',
      name: '預設',
      style: { color: '#3b82f6', lineWidth: 1, lineStyle: 2, label: '' },
    },
    {
      id: 'tpl-hline-target',
      name: '目標價',
      style: { color: '#fbbf24', lineWidth: 2, lineStyle: 0, label: '目標' },
    },
    {
      id: 'tpl-hline-key',
      name: '關鍵位',
      style: { color: '#a855f7', lineWidth: 2, lineStyle: 0, label: '關鍵' },
    },
    {
      id: 'tpl-hline-faint',
      name: '參考線',
      style: { color: '#94a3b8', lineWidth: 1, lineStyle: 3, label: '' },
    },
  ],
  rect: [
    {
      id: 'tpl-rect-default',
      name: '預設',
      style: { color: '#3b82f6', lineWidth: 1.5, lineStyle: 0, label: '' },
    },
    {
      id: 'tpl-rect-demand',
      name: '需求區',
      style: { color: '#089981', lineWidth: 2, lineStyle: 0, label: '需求' },
    },
    {
      id: 'tpl-rect-supply',
      name: '供給區',
      style: { color: '#f23645', lineWidth: 2, lineStyle: 0, label: '供給' },
    },
    {
      id: 'tpl-rect-zone',
      name: '盤整區',
      style: { color: '#fbbf24', lineWidth: 1.5, lineStyle: 2, label: '盤整' },
    },
  ],
  fib: [
    {
      id: 'tpl-fib-default',
      name: '預設',
      style: { color: '#3b82f6', lineWidth: 1, lineStyle: 0, label: '' },
    },
    {
      id: 'tpl-fib-retrace',
      name: '回撤',
      style: { color: '#a855f7', lineWidth: 1, lineStyle: 0, label: '' },
    },
  ],
  ray: [
    {
      id: 'tpl-ray-default',
      name: '預設',
      style: { color: '#3b82f6', lineWidth: 2, lineStyle: 0, label: '' },
    },
  ],
  extline: [
    {
      id: 'tpl-extline-default',
      name: '預設',
      style: { color: '#3b82f6', lineWidth: 1.5, lineStyle: 2, label: '' },
    },
  ],
  vline: [
    {
      id: 'tpl-vline-default',
      name: '預設',
      style: { color: '#787b86', lineWidth: 1, lineStyle: 2, label: '' },
    },
  ],
  channel: [
    {
      id: 'tpl-channel-default',
      name: '預設',
      style: { color: '#2962ff', lineWidth: 1.5, lineStyle: 0, label: '' },
    },
  ],
  ellipse: [
    {
      id: 'tpl-ellipse-default',
      name: '預設',
      style: { color: '#f5c878', lineWidth: 1.5, lineStyle: 0, label: '' },
    },
  ],
  arrow: [
    {
      id: 'tpl-arrow-default',
      name: '預設',
      style: { color: '#f23645', lineWidth: 2, lineStyle: 0, label: '' },
    },
  ],
  text: [
    {
      id: 'tpl-text-default',
      name: '預設',
      style: { color: '#d1d4dc', lineWidth: 2, lineStyle: 0, label: '' },
    },
  ],
  pricelabel: [
    {
      id: 'tpl-pricelabel-default',
      name: '預設',
      style: { color: '#2962ff', lineWidth: 1, lineStyle: 0, label: '' },
    },
  ],
  measure: [
    {
      id: 'tpl-measure-default',
      name: '預設',
      style: { color: '#2962ff', lineWidth: 1, lineStyle: 0, label: '' },
    },
  ],
};

// 各工具需要的取點數
const TOOL_POINTS = {
  trend: 2,
  ray: 2,
  extline: 2,
  hline: 1,
  vline: 1,
  channel: 3,
  rect: 2,
  ellipse: 2,
  fib: 2,
  arrow: 2,
  text: 1,
  pricelabel: 1,
  measure: 2,
};

export {
  BUILTIN_SYMBOLS,
  DEFAULT_DRAW_TEMPLATES,
  STORAGE_KEYS,
  TOOL_POINTS,
  dispSym,
  getPointValue,
  inScope,
  isMasked,
  posPV,
  sizeStr,
  store,
  symInfo,
  symLabel,
};
