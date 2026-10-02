"""互動煙霧測試：用真實點擊走一遍下單 → 持倉 → 平倉，驗證跨模組的事件接線。

截圖比對只證明「畫面長一樣」，這支證明「按下去真的會動」——
事件綁定在 app.js、處理函式散在 orders.js / trades.js / chart.js，
拆檔若漏了 import 或綁錯目標，這裡會失敗。
"""

from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:8234/index.html'
SEED = """
(() => {
  let s = 123456789;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
})();
"""

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='msedge')
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-TW')
    page = ctx.new_page()
    page.route('**://*.supabase.co/**', lambda r: r.abort())
    page.add_init_script(SEED)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto(URL, wait_until='load')

    # 開機 → 跳過盲測，回自由模式
    page.evaluate("""async () => {
      const a = await import('/src/auth.js');
      const app = await import('/src/app.js');
      a.hideLogin();
      await app.bootApp();
    }""")
    page.click('[data-close="blind-setup-modal"]')
    page.wait_for_timeout(600)

    def snap_state():
        return page.evaluate("""async () => {
          const { state } = await import('/src/state.js');
          return { open: state.positions.filter(p => p.status === 'open').length,
                   trades: state.trades.length,
                   cursor: state.cursorIndex };
        }""")

    print('步驟 0 開機完成 ', snap_state())

    # 1) 真實點擊：切到下單分頁 → 送出做多單
    page.click('.side-tabs button[data-pane="order"]')
    page.wait_for_timeout(200)
    page.click('#btn-submit-order')
    page.wait_for_timeout(500)
    s1 = snap_state()
    print('步驟 1 點「送出做多單」後 ', s1)
    assert s1['open'] == 1, f'下單沒生效：{s1}'

    # 2) 真實點擊：回放前進 10 根（跨 replay.js / chart.js / trades.js）
    page.click('#btn-skip10')
    page.wait_for_timeout(600)
    s2 = snap_state()
    print('步驟 2 點「前進 10 根」後 ', s2)
    assert s2['cursor'] == s1['cursor'] + 10, f'回放沒前進：{s2}'

    # 3) 真實點擊：持倉分頁 → 市價平倉 → 確認
    page.click('.side-tabs button[data-pane="positions"]')
    page.wait_for_timeout(200)
    page.click('.btn-close-pos')
    page.wait_for_timeout(300)
    page.click('#btn-confirm-close')
    page.wait_for_timeout(600)
    s3 = snap_state()
    print('步驟 3 平倉後 ', s3)
    assert s3['open'] == 0 and s3['trades'] == 1, f'平倉沒生效：{s3}'

    # 4) 真實點擊：績效分頁有算出東西
    page.click('.side-tabs button[data-pane="report"]')
    page.wait_for_timeout(400)
    txt = page.inner_text('#report-content')
    assert len(txt.strip()) > 50, f'報告是空的：{txt[:80]}'
    print(f'步驟 4 績效分頁 {len(txt)} 字')

    # 5) 畫線工具：選工具 → 在圖上點一下 → 畫出一條水平線
    page.click('.side-tabs button[data-pane="order"]')
    page.click('[data-tool="hline"]')
    page.mouse.click(600, 400)
    page.wait_for_timeout(400)
    nd = page.evaluate("""async () => {
      const { state } = await import('/src/state.js');
      return Object.values(state.drawings).flat().length;
    }""")
    print(f'步驟 5 畫線後 drawings = {nd}')
    assert nd >= 1, '畫線沒生效'

    print(f'\nJS 錯誤：{len(errors)} {errors[:3]}')
    assert not errors, '出現 JS 錯誤'
    print('互動煙霧測試全數通過')
    ctx.close()
    b.close()
