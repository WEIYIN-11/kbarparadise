// ---------- State ----------
const state = {
  symbol: 'NQ',
  timeframe: '1h',
  candles: [], // currently loaded candles (full)
  cursorIndex: -1, // index of "current" bar (last visible)
  isPlaying: false,
  playSpeed: 5, // 1..10
  playTimer: null,
  orderSide: 'long',
  positions: [],
  trades: [],
  // sideWidth / sideHeight 分開存：同一個人在電腦拉寬側欄後用手機開，不該把手機版面一起改掉
  settings: { balance: 100000, sideWidth: 340, sideHeight: 280 },
  blind: null, // 進行中盲測 { id, symbol, timeframe, scale, startIndex, endIndex, cursorIndex, playBars, startedAt }
  blindHistory: [], // 已完成盲測摘要（新到舊）
  cache: {}, // { 'NQ_1h': candles, ... }
  user: null, // { uid, email, name, photoURL } | null
  guestMode: false,
  // Drawing tools
  tool: '', // '' | trend/ray/extline/hline/vline/channel/rect/ellipse/fib/arrow/text/pricelabel/measure
  drawColor: '#3b82f6',
  firstPoint: null, // 保留舊欄位（回溯相容）
  pendingPoints: [], // 多點工具的已取點
  hoverPoint: null, // current cursor for preview
  magnet: false, // 磁鐵吸附 OHLC
  drawingsHidden: false, // 隱藏所有畫線
  drawings: {}, // { 'NQ_1h': [{id,type,points,color}, ...] }
  timeAxisVisible: true,
  selectedDrawingId: null,
  drawingDrag: null, // { drawingId, mode: 'move'|'anchor', anchorIdx, startTime, startPrice, snapshot }
  // Drawing templates: per-tool list of presets + currently active id
  drawTemplates: null, // { trend: [...], hline: [...], rect: [...], fib: [...] }
  activeTplId: {
    trend: 'tpl-trend-default',
    hline: 'tpl-hline-default',
    rect: 'tpl-rect-default',
    fib: 'tpl-fib-default',
    ray: 'tpl-ray-default',
    extline: 'tpl-extline-default',
    vline: 'tpl-vline-default',
    channel: 'tpl-channel-default',
    ellipse: 'tpl-ellipse-default',
    arrow: 'tpl-arrow-default',
    text: 'tpl-text-default',
    pricelabel: 'tpl-pricelabel-default',
    measure: 'tpl-measure-default',
  },
  // Chart-order position tool（TV 式多空部位框）
  posTool: null, // { side:'long'|'short', entry, sl, tp } | null
  // Indicators
  indicators: {
    ema: [
      { period: 9, color: '#fbbf24', enabled: false },
      { period: 20, color: '#3b82f6', enabled: false },
      { period: 50, color: '#a855f7', enabled: false },
      { period: 200, color: '#f23645', enabled: false },
    ],
    sma: [
      { period: 20, color: '#f5c878', enabled: false },
      { period: 60, color: '#e040fb', enabled: false },
    ],
    bb: { period: 20, std: 2, enabled: false },
    volume: { enabled: false },
    vwap: { color: '#ff6d00', enabled: false },
    ichimoku: { tenkan: 9, kijun: 26, senkou: 52, enabled: false },
    sar: { step: 0.02, max: 0.2, enabled: false },
    supertrend: { period: 10, mult: 3, enabled: false },
    rsi: { period: 14, enabled: false },
    macd: { fast: 12, slow: 26, signal: 9, enabled: false },
    stoch: { k: 14, kSmooth: 3, d: 3, enabled: false },
    atr: { period: 14, enabled: false },
    cci: { period: 20, enabled: false },
    obv: { enabled: false },
    adx: { period: 14, enabled: false },
  },
};

export { state };
