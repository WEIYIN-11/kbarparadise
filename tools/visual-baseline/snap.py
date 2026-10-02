"""練功房視覺回歸快照工具。

重構期間的驗收門：改程式前後各拍一輪，逐像素比對，一個像素不同就算失敗。

用法（在 repo 根目錄，先自己起一個靜態伺服器）：
    npx http-server . -p 8234 -c-1
    python tools/visual-baseline/snap.py --make-fixture      # 只需跑一次，產生固定測試資料
    python tools/visual-baseline/snap.py --out before
    python tools/visual-baseline/snap.py --out after
    python tools/visual-baseline/snap.py --compare before after

為什麼兩次拍攝能完全相同：
  · Date.now()/new Date() 被釘在固定時間（Playwright clock.set_fixed_time）
  · Math.random() 換成固定種子的 LCG（盲測抽標的、uid() 都靠它）
  · 所有 animation/transition/caret 關掉
  · localStorage 每次從同一份 fixture.json 還原
  · 所有 supabase.co 請求一律 abort —— 不連線、不寫任何資料
  · K 棒資料來自 repo 內的靜態 JSON，cursorIndex 是 floor(len*0.3)，本身就固定
"""

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
FIXTURE = HERE / 'fixture.json'
BASE_URL = 'http://127.0.0.1:8234/index.html'
FIXED_TIME = datetime(2026, 6, 15, 4, 0, 0, tzinfo=timezone.utc)

VIEWPORTS = {'desktop': (1440, 900), 'mobile': (390, 844)}

# 釘住隨機來源。必須在頁面任何程式之前執行，所以走 add_init_script。
SEED_RANDOM = """
(() => {
  let s = 123456789;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
})();
"""

# 關掉動畫、轉場與輸入游標閃爍：它們會讓同一畫面兩次拍出不同像素。
KILL_MOTION = """
* , *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
"""

# 各狀態共用的開機序。bootApp() 尾端會開盲測設定視窗，要自由模式的狀態自己按「跳過」。
PRELUDE = """
window.__snapBoot = async () => {
  hideLogin();
  await bootApp();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
};
window.__snapSkipBlind = () => {
  const b = document.querySelector('[data-close="blind-setup-modal"]');
  if (b) b.click();
};
window.__snapFree = async (pane) => {
  await window.__snapBoot();
  window.__snapSkipBlind();
  if (pane) switchSidePane(pane);
};
"""

# (名稱, 驅動這個狀態的 JS)。每支都是 async function body，在頁面 global scope 執行。
STATES = [
    ('01-login', ''),
    ('02-nomember', "showNotMember('tester@example.com');"),
    ('03-blind-setup', 'await window.__snapBoot();'),
    ('04-free-order', "await window.__snapFree('order');"),
    ('05-free-positions', "await window.__snapFree('positions');"),
    ('06-free-trades', "await window.__snapFree('trades');"),
    ('07-free-report', "await window.__snapFree('report');"),
    ('08-free-settings', "await window.__snapFree('settings');"),
    (
        '09-close-modal',
        """
        await window.__snapFree('positions');
        const p = state.positions.find(x => x.status === 'open');
        openCloseModal(p.id);
        """,
    ),
    (
        '10-fuse-modal',
        """
        await window.__snapFree('trades');
        checkLossStreak();
        """,
    ),
    (
        '11-blowup-modal',
        """
        await window.__snapFree('trades');
        updateHotStats();                      // 權益 > 0 → 爆倉判定上膛
        state.trades.unshift({ ...state.trades[0], id: 'snap-ruin', pnl: -1e9, rMultiple: -99 });
        checkBlowUp();
        """,
    ),
    (
        '12-draw-tool-active',
        """
        await window.__snapFree('order');
        setTool('hline');
        """,
    ),
    (
        '13-side-resized',
        """
        await window.__snapFree('positions');
        const main = document.getElementById('main-pane');
        main.style.setProperty('--side-w', '520px');
        main.style.setProperty('--side-h', '420px');
        syncPaneChartSizes();
        """,
    ),
]

# fixture 用固定 id，價格與時間則由靜態 K 棒資料推導（硬寫價格會落在圖表範圍外看不到）。
MAKE_FIXTURE = """
() => {
  const c = state.candles, cur = state.cursorIndex;
  const at = (off) => c[cur - off];
  const dp = (v) => +v.toFixed(2);
  const mk = (i, side, off, pnlR) => {
    const e = at(off), x = at(off - 8);
    const risk = 1000;
    return {
      id: 'fx-t' + i, symbol: 'NQ', timeframe: '1h', side, status: 'closed',
      entryPrice: dp(e.close), entryTime: e.time,
      exitPrice: dp(x.close), exitTime: x.time,
      size: 1, stopLoss: dp(e.low), takeProfit: dp(e.high),
      riskAmount: risk, riskPct: 1,
      strategyTag: ['突破', '回測', '轉折'][i % 3],
      pnl: risk * pnlR, pnlPts: dp(risk * pnlR / 20), rMultiple: pnlR,
      exitReason: pnlR >= 0 ? '提前獲利了結' : '提前砍單停損',
      exitNote: '', blindId: null,
    };
  };
  // 最後三筆連虧 → 連敗熔斷視窗能用真實路徑叫出來
  const trades = [mk(1, 'long', 120, -1), mk(2, 'short', 100, -1), mk(3, 'long', 80, -1),
                  mk(4, 'long', 60, 2.4), mk(5, 'short', 40, 1.1), mk(6, 'long', 20, -0.6)];
  const openBar = at(6), pendBar = at(2);
  const positions = [
    { id: 'fx-p1', symbol: 'NQ', timeframe: '1h', side: 'long', status: 'open',
      entryPrice: dp(openBar.close), entryTime: openBar.time, size: 2,
      stopLoss: dp(openBar.close * 0.99), takeProfit: dp(openBar.close * 1.02),
      riskAmount: 1500, riskPct: 1.5, strategyTag: '順勢', blindId: null,
      reason: '前高突破回測不破' },
    { id: 'fx-p2', symbol: 'NQ', timeframe: '1h', side: 'short', status: 'pending',
      entryPrice: dp(pendBar.close * 1.01), entryTime: pendBar.time, size: 1,
      stopLoss: dp(pendBar.close * 1.02), takeProfit: dp(pendBar.close * 0.98),
      riskAmount: 800, riskPct: 0.8, strategyTag: '區間操作', blindId: null, reason: '' },
  ];
  const drawings = { 'NQ_1h': [
    { id: 'fx-d1', type: 'hline', color: '#3b82f6',
      points: [{ time: at(40).time, price: dp(at(40).high) }] },
    { id: 'fx-d2', type: 'rect', color: '#f59e0b',
      points: [{ time: at(30).time, price: dp(at(30).high) },
               { time: at(10).time, price: dp(at(10).low) }] },
  ] };
  return {
    trades: { trades, positions },
    settings: { balance: 100000, sideWidth: 340, sideHeight: 280 },
    drawings,
  };
}
"""


def seed_script(fx):
    """把 fixture 寫進 localStorage，在頁面任何程式之前執行。"""
    return (
        'try {'
        f'localStorage.setItem("tradersim_trades_v1", {json.dumps(json.dumps(fx["trades"]))});'
        f'localStorage.setItem("tradersim_settings_v1", {json.dumps(json.dumps(fx["settings"]))});'
        f'localStorage.setItem("tradersim_drawings_v1", {json.dumps(json.dumps(fx["drawings"]))});'
        '} catch (e) {}'
    )


def new_page(browser, width, height, seed):
    ctx = browser.new_context(viewport={'width': width, 'height': height},
                              device_scale_factor=1, locale='zh-TW',
                              timezone_id='Asia/Taipei')
    page = ctx.new_page()
    page.clock.set_fixed_time(FIXED_TIME)
    page.route('**://*.supabase.co/**', lambda route: route.abort())
    page.add_init_script(SEED_RANDOM)
    if seed:
        page.add_init_script(seed)
    page.add_init_script(PRELUDE)
    return ctx, page


def capture(out_dir):
    if not FIXTURE.exists():
        sys.exit('找不到 fixture.json，請先跑 --make-fixture')
    fx = json.loads(FIXTURE.read_text(encoding='utf-8'))
    seed = seed_script(fx)
    out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='msedge')
        for vp_name, (w, h) in VIEWPORTS.items():
            for state_name, driver in STATES:
                ctx, page = new_page(browser, w, h, seed)
                page.goto(BASE_URL, wait_until='load')
                page.add_style_tag(content=KILL_MOTION)
                if driver:
                    page.evaluate(f'async () => {{ {driver} }}')
                # 等圖表與版面都靜下來（rAF 兩幀 + 固定沉澱時間）
                page.evaluate(
                    '() => new Promise(r => requestAnimationFrame('
                    '() => requestAnimationFrame(r)))')
                page.wait_for_timeout(450)
                page.screenshot(path=str(out_dir / f'{vp_name}-{state_name}.png'),
                                full_page=True, animations='disabled',
                                caret='hide', scale='css')
                ctx.close()
                n += 1
                print(f'  [{n:>2}] {vp_name}-{state_name}')
        browser.close()
    print(f'已拍 {n} 張 → {out_dir}')


def compare(dir_a, dir_b):
    from PIL import Image, ImageChops
    names = sorted({p.name for p in dir_a.glob('*.png')} | {p.name for p in dir_b.glob('*.png')})
    same = bad = 0
    for name in names:
        pa, pb = dir_a / name, dir_b / name
        if not pa.exists() or not pb.exists():
            print(f'  ✗ {name}: 只存在於其中一邊')
            bad += 1
            continue
        if pa.read_bytes() == pb.read_bytes():
            same += 1
            continue
        ia, ib = Image.open(pa).convert('RGB'), Image.open(pb).convert('RGB')
        if ia.size != ib.size:
            print(f'  ✗ {name}: 尺寸不同 {ia.size} vs {ib.size}')
            bad += 1
            continue
        diff = ImageChops.difference(ia, ib)
        box = diff.getbbox()
        if box is None:
            same += 1          # 位元組不同但像素全同（PNG 壓縮差異）
            continue
        npx = sum(1 for px in diff.getdata() if px != (0, 0, 0))
        print(f'  ✗ {name}: {npx} 個像素不同，範圍 {box}')
        bad += 1
    print(f'\n結果：{same}/{len(names)} 完全一致，{bad} 個不同')
    return bad == 0


def make_fixture():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='msedge')
        ctx, page = new_page(browser, 1440, 900, None)
        page.goto(BASE_URL, wait_until='load')
        page.evaluate('async () => { await window.__snapBoot(); }')
        fx = page.evaluate(MAKE_FIXTURE)
        ctx.close()
        browser.close()
    FIXTURE.write_text(json.dumps(fx, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'fixture 已寫入 {FIXTURE}')
    print(f'  {len(fx["trades"]["trades"])} 筆已平倉、'
          f'{len(fx["trades"]["positions"])} 筆持倉/掛單、'
          f'{len(fx["drawings"]["NQ_1h"])} 個繪圖')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--make-fixture', action='store_true')
    ap.add_argument('--out')
    ap.add_argument('--compare', nargs=2, metavar=('A', 'B'))
    a = ap.parse_args()
    if a.make_fixture:
        make_fixture()
    elif a.out:
        capture(pathlib.Path(a.out))
    elif a.compare:
        ok = compare(pathlib.Path(a.compare[0]), pathlib.Path(a.compare[1]))
        sys.exit(0 if ok else 1)
    else:
        ap.print_help()


if __name__ == '__main__':
    main()
