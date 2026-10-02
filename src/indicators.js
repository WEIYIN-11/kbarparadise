import { candleSeries, chart } from './chart.js';
import { state } from './state.js';
import { $ } from './util.js';

// Indicators: calc + render
// ============================================================

// ---- Calculations ----
function calcEMA(candles, period) {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  let ema = sum / period;
  out.push({ time: candles[period - 1].time, value: ema });
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    out.push({ time: candles[i].time, value: ema });
  }
  return out;
}
function calcBB(candles, period, stdMul) {
  if (candles.length < period) return { upper: [], middle: [], lower: [] };
  const upper = [],
    middle = [],
    lower = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    const mean = sum / period;
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      varSum += (candles[i - j].close - mean) ** 2;
    }
    const std = Math.sqrt(varSum / period);
    const t = candles[i].time;
    upper.push({ time: t, value: mean + std * stdMul });
    middle.push({ time: t, value: mean });
    lower.push({ time: t, value: mean - std * stdMul });
  }
  return { upper, middle, lower };
}
function calcRSI(candles, period) {
  if (candles.length < period + 1) return [];
  const out = [];
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    if (ch > 0) gains += ch;
    else losses -= ch;
  }
  let avgG = gains / period,
    avgL = losses / period;
  const rsi = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out.push({ time: candles[period].time, value: rsi(avgG, avgL) });
  for (let i = period + 1; i < candles.length; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out.push({ time: candles[i].time, value: rsi(avgG, avgL) });
  }
  return out;
}
function calcEMAOnSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i].value;
  let e = sum / period;
  out.push({ time: values[period - 1].time, value: e });
  for (let i = period; i < values.length; i++) {
    e = values[i].value * k + e * (1 - k);
    out.push({ time: values[i].time, value: e });
  }
  return out;
}
function calcMACD(candles, fastP, slowP, signalP) {
  const fast = calcEMA(candles, fastP);
  const slow = calcEMA(candles, slowP);
  const slowMap = new Map(slow.map((x) => [x.time, x.value]));
  const macd = [];
  for (const f of fast) {
    if (slowMap.has(f.time)) macd.push({ time: f.time, value: f.value - slowMap.get(f.time) });
  }
  const signal = calcEMAOnSeries(macd, signalP);
  const sigMap = new Map(signal.map((x) => [x.time, x.value]));
  const hist = [];
  for (const m of macd) {
    if (sigMap.has(m.time)) {
      const v = m.value - sigMap.get(m.time);
      hist.push({
        time: m.time,
        value: v,
        color: v >= 0 ? 'rgba(8,153,129,0.7)' : 'rgba(242,54,69,0.7)',
      });
    }
  }
  return { macd, signal, hist };
}

// ---- 新增指標計算（TV 免費常用指標）----
function calcSMA(candles, period) {
  if (candles.length < period) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}
// VWAP：1h 每日重置（TV 標準）；1d 以資料起點錨定
function calcVWAP(candles, tf) {
  const out = [];
  let cumPV = 0,
    cumV = 0,
    curDay = null;
  for (const c of candles) {
    if (tf !== '1d') {
      const day = Math.floor((c.time + 8 * 3600) / 86400);
      if (day !== curDay) {
        curDay = day;
        cumPV = 0;
        cumV = 0;
      }
    }
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * (c.volume || 0);
    cumV += c.volume || 0;
    out.push({ time: c.time, value: cumV > 0 ? cumPV / cumV : tp });
  }
  return out;
}
function smaOnSeries(arr, p) {
  const o = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i].value;
    if (i >= p) sum -= arr[i - p].value;
    if (i >= p - 1) o.push({ time: arr[i].time, value: sum / p });
  }
  return o;
}
function calcStoch(candles, kP, kSmooth, dP) {
  if (candles.length < kP) return { k: [], d: [] };
  const raw = [];
  for (let i = kP - 1; i < candles.length; i++) {
    let hh = -Infinity,
      ll = Infinity;
    for (let j = 0; j < kP; j++) {
      hh = Math.max(hh, candles[i - j].high);
      ll = Math.min(ll, candles[i - j].low);
    }
    raw.push({
      time: candles[i].time,
      value: hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100,
    });
  }
  const k = smaOnSeries(raw, kSmooth);
  const d = smaOnSeries(k, dP);
  return { k, d };
}
const trueRangeAt = (c, i) =>
  Math.max(
    c[i].high - c[i].low,
    Math.abs(c[i].high - c[i - 1].close),
    Math.abs(c[i].low - c[i - 1].close),
  );
function calcATR(candles, period) {
  // Wilder
  if (candles.length < period + 1) return [];
  const out = [];
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trueRangeAt(candles, i);
  atr /= period;
  out.push({ time: candles[period].time, value: atr });
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRangeAt(candles, i)) / period;
    out.push({ time: candles[i].time, value: atr });
  }
  return out;
}
function calcCCI(candles, period) {
  if (candles.length < period) return [];
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const out = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += tp[i - j];
    const mean = sum / period;
    let dev = 0;
    for (let j = 0; j < period; j++) dev += Math.abs(tp[i - j] - mean);
    dev /= period;
    out.push({
      time: candles[i].time,
      value: dev === 0 ? 0 : (tp[i] - mean) / (0.015 * dev),
    });
  }
  return out;
}
function calcOBV(candles) {
  const out = [];
  let obv = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      if (candles[i].close > candles[i - 1].close) obv += candles[i].volume || 0;
      else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume || 0;
    }
    out.push({ time: candles[i].time, value: obv });
  }
  return out;
}
function calcADX(candles, period) {
  // Wilder DMI/ADX
  if (candles.length < period * 2 + 1) return { adx: [], plus: [], minus: [] };
  const pdmAt = (i) => {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    return up > dn && up > 0 ? up : 0;
  };
  const mdmAt = (i) => {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    return dn > up && dn > 0 ? dn : 0;
  };
  let trS = 0,
    pdmS = 0,
    mdmS = 0;
  for (let i = 1; i <= period; i++) {
    trS += trueRangeAt(candles, i);
    pdmS += pdmAt(i);
    mdmS += mdmAt(i);
  }
  const plus = [],
    minus = [],
    dxArr = [];
  const emit = (i) => {
    const pdi = trS === 0 ? 0 : (100 * pdmS) / trS;
    const mdi = trS === 0 ? 0 : (100 * mdmS) / trS;
    plus.push({ time: candles[i].time, value: pdi });
    minus.push({ time: candles[i].time, value: mdi });
    dxArr.push({
      time: candles[i].time,
      value: pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi),
    });
  };
  emit(period);
  for (let i = period + 1; i < candles.length; i++) {
    trS = trS - trS / period + trueRangeAt(candles, i);
    pdmS = pdmS - pdmS / period + pdmAt(i);
    mdmS = mdmS - mdmS / period + mdmAt(i);
    emit(i);
  }
  const adx = [];
  if (dxArr.length >= period) {
    let a = 0;
    for (let i = 0; i < period; i++) a += dxArr[i].value;
    a /= period;
    adx.push({ time: dxArr[period - 1].time, value: a });
    for (let i = period; i < dxArr.length; i++) {
      a = (a * (period - 1) + dxArr[i].value) / period;
      adx.push({ time: dxArr[i].time, value: a });
    }
  }
  return { adx, plus, minus };
}
function calcSAR(candles, step, maxStep) {
  if (candles.length < 5) return [];
  const out = [];
  let up = candles[1].close >= candles[0].close;
  let sar = up ? candles[0].low : candles[0].high;
  let ep = up ? candles[0].high : candles[0].low;
  let af = step;
  for (let i = 1; i < candles.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, candles[i - 1].low, candles[Math.max(0, i - 2)].low);
      if (candles[i].low < sar) {
        up = false;
        sar = ep;
        ep = candles[i].low;
        af = step;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(maxStep, af + step);
      }
    } else {
      sar = Math.max(sar, candles[i - 1].high, candles[Math.max(0, i - 2)].high);
      if (candles[i].high > sar) {
        up = true;
        sar = ep;
        ep = candles[i].high;
        af = step;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(maxStep, af + step);
      }
    }
    out.push({ time: candles[i].time, value: sar, up });
  }
  return out;
}
function calcSuperTrend(candles, period, mult) {
  const atr = calcATR(candles, period);
  if (!atr.length) return [];
  const atrMap = new Map(atr.map((a) => [a.time, a.value]));
  const out = [];
  let fu = null,
    fl = null,
    trendUp = true,
    prevClose = null;
  for (const c of candles) {
    const a = atrMap.get(c.time);
    if (a == null) {
      prevClose = c.close;
      continue;
    }
    const mid = (c.high + c.low) / 2;
    const bu = mid + mult * a;
    const bl = mid - mult * a;
    fu = fu == null || bu < fu || (prevClose != null && prevClose > fu) ? bu : fu;
    fl = fl == null || bl > fl || (prevClose != null && prevClose < fl) ? bl : fl;
    if (trendUp && c.close < fl) trendUp = false;
    else if (!trendUp && c.close > fu) trendUp = true;
    out.push({ time: c.time, value: trendUp ? fl : fu, up: trendUp });
    prevClose = c.close;
  }
  return out;
}
function calcIchimoku(candles, tenkanP, kijunP, senkouP) {
  const n = candles.length;
  const midAt = (i, p) => {
    let hh = -Infinity,
      ll = Infinity;
    for (let j = 0; j < p; j++) {
      hh = Math.max(hh, candles[i - j].high);
      ll = Math.min(ll, candles[i - j].low);
    }
    return (hh + ll) / 2;
  };
  const interval = n >= 2 ? Math.round((candles[n - 1].time - candles[0].time) / (n - 1)) : 86400;
  const timeAt = (i) => (i < n ? candles[i].time : candles[n - 1].time + (i - n + 1) * interval);
  const tenkan = [],
    kijun = [],
    senkouA = [],
    senkouB = [],
    chikou = [];
  for (let i = 0; i < n; i++) {
    if (i >= tenkanP - 1) tenkan.push({ time: candles[i].time, value: midAt(i, tenkanP) });
    if (i >= kijunP - 1) kijun.push({ time: candles[i].time, value: midAt(i, kijunP) });
    if (i >= Math.max(tenkanP, kijunP) - 1) {
      senkouA.push({
        time: timeAt(i + kijunP),
        value: (midAt(i, tenkanP) + midAt(i, kijunP)) / 2,
      });
    }
    if (i >= senkouP - 1) senkouB.push({ time: timeAt(i + kijunP), value: midAt(i, senkouP) });
    if (i >= kijunP) chikou.push({ time: candles[i - kijunP].time, value: candles[i].close });
  }
  return { tenkan, kijun, senkouA, senkouB, chikou };
}

// ---- Series tracking ----
let overlaySeriesList = []; // 主圖疊加 series（每次 render 重建）
const subCharts = {}; // name -> { chart, series: {...} }
let ichimokuCloudCache = null; // canvas 雲帶填色用
let sarCache = null; // canvas SAR 點用

function safeRemoveSeries(chartObj, series) {
  if (!series || !chartObj) return;
  try {
    chartObj.removeSeries(series);
  } catch {}
}

function clearAllIndicatorSeries() {
  for (const s of overlaySeriesList) safeRemoveSeries(chart, s);
  overlaySeriesList = [];
  ichimokuCloudCache = null;
  sarCache = null;
}

function addOverlayLine(opts, data) {
  const s = chart.addLineSeries({
    priceLineVisible: false,
    lastValueVisible: false,
    ...opts,
  });
  s.setData(data);
  overlaySeriesList.push(s);
  return s;
}

function ensureSubpane(name, label) {
  const wrap = $('subpanes-wrap');
  let pane = $(`subpane-${name}`);
  if (!pane) {
    pane = document.createElement('div');
    pane.id = `subpane-${name}`;
    pane.className = 'subpane';
    pane.innerHTML = `<div class="subpane-label"></div><div class="subpane-chart"></div>`;
    wrap.appendChild(pane);
  }
  pane.querySelector('.subpane-label').textContent = label;
  return pane;
}
function destroySubpane(name) {
  const pane = $(`subpane-${name}`);
  if (pane) pane.remove();
}
// 泛用子圖：build(chart) 回傳 series map，只建一次
function getSubChart(name, label, build) {
  const pane = ensureSubpane(name, label);
  if (!subCharts[name]) {
    const c = createSubChart(pane);
    subCharts[name] = { chart: c, series: build(c) };
  }
  return subCharts[name];
}
function dropSubChart(name) {
  const sc = subCharts[name];
  if (!sc) return;
  try {
    sc.chart.remove();
  } catch {}
  delete subCharts[name];
  destroySubpane(name);
}

function createSubChart(paneEl) {
  const inner = paneEl.querySelector('.subpane-chart');
  const c = LightweightCharts.createChart(inner, {
    layout: { background: { color: '#131722' }, textColor: '#9598a1' },
    grid: {
      vertLines: { color: 'rgba(42,46,57,0.35)' },
      horzLines: { color: 'rgba(42,46,57,0.55)' },
    },
    rightPriceScale: { borderColor: '#2a2e39' },
    timeScale: { visible: false, borderVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: false,
    handleScale: false,
  });
  return c;
}

// Sync subpane time axes with main chart
function syncSubpaneRanges(range) {
  if (!range) return;
  for (const sc of Object.values(subCharts)) {
    try {
      sc.chart.timeScale().setVisibleLogicalRange(range);
    } catch {}
  }
}

function renderIndicators(visible) {
  if (!chart || !candleSeries) return;
  const ind = state.indicators;
  clearAllIndicatorSeries();

  // ---- 主圖疊加 ----
  ind.ema.forEach((cfg) => {
    if (!cfg.enabled) return;
    const data = calcEMA(visible, cfg.period);
    if (data.length)
      addOverlayLine(
        {
          color: cfg.color,
          lineWidth: 1.5,
          lastValueVisible: true,
          title: `EMA${cfg.period}`,
        },
        data,
      );
  });
  ind.sma.forEach((cfg) => {
    if (!cfg.enabled) return;
    const data = calcSMA(visible, cfg.period);
    if (data.length)
      addOverlayLine(
        {
          color: cfg.color,
          lineWidth: 1.5,
          lastValueVisible: true,
          title: `SMA${cfg.period}`,
        },
        data,
      );
  });
  if (ind.bb.enabled) {
    const { upper, middle, lower } = calcBB(visible, ind.bb.period, ind.bb.std);
    addOverlayLine({ color: 'rgba(149,152,161,0.7)', lineWidth: 1, title: 'BB+' }, upper);
    addOverlayLine(
      { color: 'rgba(245,200,120,0.8)', lineWidth: 1, lineStyle: 2, title: 'BB ' },
      middle,
    );
    addOverlayLine({ color: 'rgba(149,152,161,0.7)', lineWidth: 1, title: 'BB-' }, lower);
  }
  if (ind.vwap.enabled) {
    const data = calcVWAP(visible, state.timeframe);
    if (data.length)
      addOverlayLine(
        { color: ind.vwap.color, lineWidth: 1.5, lastValueVisible: true, title: 'VWAP' },
        data,
      );
  }
  if (ind.ichimoku.enabled) {
    const m = calcIchimoku(visible, ind.ichimoku.tenkan, ind.ichimoku.kijun, ind.ichimoku.senkou);
    addOverlayLine({ color: '#2962ff', lineWidth: 1, title: '轉換' }, m.tenkan);
    addOverlayLine({ color: '#b71c1c', lineWidth: 1, title: '基準' }, m.kijun);
    addOverlayLine({ color: 'rgba(8,153,129,0.55)', lineWidth: 1, title: '先行A' }, m.senkouA);
    addOverlayLine({ color: 'rgba(242,54,69,0.55)', lineWidth: 1, title: '先行B' }, m.senkouB);
    addOverlayLine({ color: '#43a047', lineWidth: 1, lineStyle: 1, title: '遲行' }, m.chikou);
    ichimokuCloudCache = {
      a: m.senkouA,
      b: new Map(m.senkouB.map((x) => [x.time, x.value])),
    };
  }
  if (ind.supertrend.enabled) {
    const st = calcSuperTrend(visible, ind.supertrend.period, ind.supertrend.mult);
    if (st.length) {
      // 以 whitespace 斷開多空段
      const upData = st.map((x) => (x.up ? { time: x.time, value: x.value } : { time: x.time }));
      const dnData = st.map((x) => (!x.up ? { time: x.time, value: x.value } : { time: x.time }));
      addOverlayLine({ color: '#089981', lineWidth: 2, title: 'ST' }, upData);
      addOverlayLine({ color: '#f23645', lineWidth: 2 }, dnData);
    }
  }
  if (ind.sar.enabled) {
    sarCache = calcSAR(visible, ind.sar.step, ind.sar.max); // 以 canvas 畫點
  }
  if (ind.volume.enabled) {
    const s = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    s.setData(
      visible.map((c) => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? 'rgba(8,153,129,0.5)' : 'rgba(242,54,69,0.5)',
      })),
    );
    overlaySeriesList.push(s);
  }

  // ---- 副圖 ----
  if (ind.rsi.enabled) {
    const sc = getSubChart('rsi', `RSI(${ind.rsi.period})`, (c) => {
      const line = c.addLineSeries({
        color: '#7e57c2',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      line.createPriceLine({
        price: 70,
        color: 'rgba(242,54,69,0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      line.createPriceLine({
        price: 30,
        color: 'rgba(8,153,129,0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      line.createPriceLine({
        price: 50,
        color: 'rgba(149,152,161,0.3)',
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: false,
      });
      return { line };
    });
    sc.series.line.setData(calcRSI(visible, ind.rsi.period));
  } else dropSubChart('rsi');

  if (ind.macd.enabled) {
    const cfg = ind.macd;
    const sc = getSubChart('macd', `MACD(${cfg.fast},${cfg.slow},${cfg.signal})`, (c) => {
      const hist = c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      const line = c.addLineSeries({
        color: '#2962ff',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'MACD',
      });
      const signal = c.addLineSeries({
        color: '#ff6d00',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'Signal',
      });
      line.createPriceLine({
        price: 0,
        color: 'rgba(149,152,161,0.4)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      return { hist, line, signal };
    });
    const m = calcMACD(visible, cfg.fast, cfg.slow, cfg.signal);
    sc.series.hist.setData(m.hist);
    sc.series.line.setData(m.macd);
    sc.series.signal.setData(m.signal);
  } else dropSubChart('macd');

  if (ind.stoch.enabled) {
    const cfg = ind.stoch;
    const sc = getSubChart('stoch', `KD 隨機(${cfg.k},${cfg.kSmooth},${cfg.d})`, (c) => {
      const k = c.addLineSeries({
        color: '#2962ff',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'K',
      });
      const d = c.addLineSeries({
        color: '#ff6d00',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'D',
      });
      k.createPriceLine({
        price: 80,
        color: 'rgba(242,54,69,0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      k.createPriceLine({
        price: 20,
        color: 'rgba(8,153,129,0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      return { k, d };
    });
    const kd = calcStoch(visible, cfg.k, cfg.kSmooth, cfg.d);
    sc.series.k.setData(kd.k);
    sc.series.d.setData(kd.d);
  } else dropSubChart('stoch');

  if (ind.atr.enabled) {
    const sc = getSubChart('atr', `ATR(${ind.atr.period})`, (c) => ({
      line: c.addLineSeries({
        color: '#f5c878',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
      }),
    }));
    sc.series.line.setData(calcATR(visible, ind.atr.period));
  } else dropSubChart('atr');

  if (ind.cci.enabled) {
    const sc = getSubChart('cci', `CCI(${ind.cci.period})`, (c) => {
      const line = c.addLineSeries({
        color: '#26c6da',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      line.createPriceLine({
        price: 100,
        color: 'rgba(242,54,69,0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      line.createPriceLine({
        price: -100,
        color: 'rgba(8,153,129,0.5)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      line.createPriceLine({
        price: 0,
        color: 'rgba(149,152,161,0.3)',
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: false,
      });
      return { line };
    });
    sc.series.line.setData(calcCCI(visible, ind.cci.period));
  } else dropSubChart('cci');

  if (ind.obv.enabled) {
    const sc = getSubChart('obv', 'OBV 能量潮', (c) => ({
      line: c.addLineSeries({
        color: '#90a4ae',
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
      }),
    }));
    sc.series.line.setData(calcOBV(visible));
  } else dropSubChart('obv');

  if (ind.adx.enabled) {
    const sc = getSubChart('adx', `ADX/DMI(${ind.adx.period})`, (c) => {
      const adx = c.addLineSeries({
        color: '#f5c878',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: 'ADX',
      });
      const plus = c.addLineSeries({
        color: '#089981',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        title: '+DI',
      });
      const minus = c.addLineSeries({
        color: '#f23645',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        title: '-DI',
      });
      adx.createPriceLine({
        price: 25,
        color: 'rgba(149,152,161,0.4)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
      });
      return { adx, plus, minus };
    });
    const m = calcADX(visible, ind.adx.period);
    sc.series.adx.setData(m.adx);
    sc.series.plus.setData(m.plus);
    sc.series.minus.setData(m.minus);
  } else dropSubChart('adx');

  // Sync subpane time scales to main chart visible range
  try {
    const range = chart.timeScale().getVisibleLogicalRange();
    syncSubpaneRanges(range);
  } catch {}
}

// ============================================================

export { ichimokuCloudCache, renderIndicators, sarCache, subCharts, syncSubpaneRanges };
