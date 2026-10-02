# 練功房 (TraderSim)

交易模擬訓練工具：用歷史 K 棒練習進出場時機，回放、模擬下單、盲測隨機標的、彙整績效報告給教練檢討。

## 標的（動態組成，約 100 檔，清單見 `data/symbols.json`）

- **期指**（固定）：NQ 那斯達克100期貨、TXF 台指期（1H 用 ^TWII 加權指數替代）
- **加密貨幣**：Binance USDT 現貨「近 30 天成交額」**前 30 名**（每次 `npm run fetch` 重新排名）＋固定保底 BTC/ETH/SOL/BNB/XRP/DOGE
- **美股**：候選池內「近 30 天成交量」**前 30 名**＋固定保底既有 11 檔
- **台股**：候選池內「近 30 天成交量」**前 30 名**＋固定保底既有 10 檔

排名邏輯、候選池、點值（換算 USD）都在 `scripts/fetch-data.mjs`，
執行後產出 `data/symbols.json` 給前端動態載入；本次組成快取在 `data/registry-cache.json`。
要加候選標的：改 US_POOL / TW_POOL / 加密排除清單 → `npm run fetch`。
排名會帶進低價幣（SHIB/PEPE 等），前端價格顯示為自適應小數位。

## 資料涵蓋

| 類別                   | 日線                         | 1 小時            |
| ---------------------- | ---------------------------- | ----------------- |
| BTC                    | 2020-01-01 ~ 今日            | 2020-01-01 ~ 今日 |
| ETH / SOL              | 2020 (SOL 為上市日) ~ 今日   | 近 720 天         |
| NQ / TXF               | 2020-01-01 ~ 今日            | 約最近 2 年       |
| 其他加密 / 美股 / 台股 | 2020-01-01（或上市日）~ 今日 | —（無 1H）        |

新上市的高量幣歷史可能很短（如 60 根），盲測抽標的時會自動略過長度不足者。

## 主要功能

### 圖表 / 回放

- 雙週期：1H / 1D（無 1H 資料的標的自動鎖定 1D）
- K 棒回放（◀ ▶ 速度滑桿、跳轉日期）
- 空白鍵 / 方向鍵控制
- 時間軸可隱藏

### 🎲 盲測模式（登入後預設入口）

- 登入 / 訪客進站即彈出盲測設定；按「跳過，自由練習」可回到自選標的模式
- 從勾選類別（台股/美股/加密/期指）隨機抽 1 檔、隨機起始時間
- **標的名稱與日期隱藏**，價格正規化為起始 = 100（金額計算不受影響）
- 測驗長度可選 100 / 200 / 300 根 K 棒，跑完或手動結束即揭曉
- 揭曉統計：多/空交易次數、總勝率與多空分項勝率、總盈虧、平均 R、同期買進持有對照
- 盲測中途關頁可續玩；歷史紀錄列於「報告」分頁並同步雲端

### 畫圖工具（TV 式工具列，13 種）

- **線類**：趨勢線、射線、延伸線、水平線、垂直線、平行通道（3 點）
- **圖形**：矩形、橢圓、斐波那契回撤
- **註記**：箭頭、文字、價格標籤
- **測量**：TV 式測量工具（價差 / % / K 棒數）
- **磁鐵吸附**：取點自動吸附 K 棒 OHLC；**一鍵隱藏/顯示所有畫線**
- **模板系統**：每個工具可儲存多組樣式預設（顏色、線寬、線型、標籤）
- 點擊圖形可選取、拖曳錨點重塑或整體平移；圖表類型可切換 K棒/美國線/折線/面積

### 模擬交易

- 多空下單，自動依風險％計算部位大小
- SL/TP 線可直接拖曳，金額即時更新
- SL 可拉到進場價之上鎖利（限制不能超過當前價）
- 「策略標籤 × 出場原因」交叉表，揭露紀律破口

### 技術指標（TradingView 免費常用 15 種）

- **疊加在主圖**：EMA × 4、SMA × 2（可自訂週期/顏色）、布林通道、VWAP（1H 每日重置）、
  一目均衡表（含雲帶填色）、SAR 拋物線、SuperTrend、成交量
- **獨立子圖**：RSI、MACD、KD 隨機、ATR、CCI、OBV、ADX/DMI（子圖可同時開多個）

### 🎯 圖表下單部位工具（TV 式）

- 左側工具列多/空部位按鈕 → 圖上出現進場線＋止盈綠區＋止損紅區
- 三條線都能拖曳：**拖進場線整組平移**、拖 TP/SL 單獨調整（自動防呆不可穿越進場價）
- 圖上即時顯示目標金額、風險金額與 R 倍數，並與下單面板雙向同步
- 持倉中的部位同樣顯示紅綠止盈/止損色帶，SL/TP 線可直接拖曳（原有功能）
- 介面配色完全比照 TradingView 深色主題（#131722 底、#089981/#f23645 紅綠 K）

### 帳號與雲端同步（方舟藍圖 Supabase，完全整合）

- **與方舟藍圖同一組帳號**：Google 登入或 Email magic link
- **白名單＝方舟訂閱會員**：`members` 表 tier ∈ 付費方案且未過期（或 admin）即可進入，
  不需要手動維護白名單；訂閱過期自動擋
- 跨裝置同步：交易、畫線、指標設定、模板、盲測進度都存 `tradersim_states`（debounce 1.5s upsert）
- **教練檢視**：方舟後台 `/admin/tradersim` 直接看所有學員的績效摘要、交易明細、盲測歷史

## 開發指令

```bash
npm install          # 開發工具（Prettier / ESLint），不影響上線內容

npm run serve        # 本機啟動 → http://localhost:8081
npm run fetch        # 抓取最新歷史資料

npm run check        # = lint + 格式檢查，提交前跑這個
npm run format       # 自動排版
npm run lint         # 只跑 ESLint
```

測試需要先開著本機伺服器（預設讀 `http://127.0.0.1:8234`，見
`tools/visual-baseline/snap.py` 的 `BASE_URL`）：

```bash
npm run test:smoke   # 真實點擊走一遍下單→前進→平倉→績效→畫線
npm run test:visual  # 拍 26 張快照，再用 --compare 跟改動前比對
```

## 程式碼結構

```
index.html              只有 HTML 結構，不含任何樣式與邏輯
src/
  styles.css            全站樣式
  auth-bootstrap.js     Supabase client、跨子網域共用 session、推薦碼捕捉
  constants.js          共用常數 + store（跨模組共享的可變狀態）
  state.js              state 物件（畫面與交易的當下狀態）
  util.js               格式化與小工具
  storage.js            localStorage 存取
  data.js               K 棒載入
  chart.js              圖表建立、版面分隔線、圖表類型
  indicators.js         技術指標計算與繪製
  drawings.js           畫線工具（canvas overlay）
  position-tools.js     SL/TP 線拖曳、繪圖選取與拖曳
  replay.js             回放與 SL/TP 觸發
  orders.js             下單、持倉管理、連敗熔斷、爆倉
  trades.js             交易紀錄、回放檢討、績效、側欄分頁
  auth.js               登入與雲端同步、設定
  blind.js              盲測模式
  templates.js          畫線樣板 UI
  app.js                事件接線、登入流程、開機（進入點）
vendor/                 第三方程式庫（自架，勿改）
tools/                  開發用檢查工具，不會上傳到網站
data/                   K 棒資料（約 28MB，已納入版控）
```

### 動這份程式碼要遵守的規則

- **共享的可變狀態只放兩個地方**：畫面與交易的當下狀態放 `state.js` 的
  `state`；會被「不同模組」重新賦值的放 `constants.js` 的 `store`。ES module
  的 import 是唯讀綁定，直接寫 `X = v` 會在執行時報錯。只在自己模組內改值的
  變數不要放進 `store` —— `export let` 的綁定是即時的，其他模組 import 後讀
  得到新值，否則 `store` 會退化成第二個全域命名空間。

- **跨模組 import 進來的東西只能在函式體內用，不能在模組載入當下使用**。
  模組之間有循環相依（下單要重畫紀錄、回放會觸發平倉，領域邏輯本身就互相
  呼叫）。循環在 ES module 下只有在「載入期不去碰對方」時才安全。

- **寫進 `innerHTML` 的動態文字一律過 `escHtml()`**，特別是使用者輸入的
  策略標籤與進場理由。

- **第三方程式庫只能從 `vendor/` 載入，不要改回 CDN**。這一頁的任何腳本都
  讀得到跨子網域共用的登入 cookie，CDN 被下毒等於一次拿到四站所有會員的
  session。升級版本＝重新下載整包放進 `vendor/` 並改檔名。

- **`index.html` 與 `src/` 必須同進同退**。兩者在 `_headers` 都設成 no-store，
  不要給 `src/` 加快取，否則部署後會出現「新的 HTML 配舊的 JS」。

- **不能用 `wrangler dev` 預覽**。資產目錄是 `.`，wrangler 會把暫存檔寫進
  同一個目錄觸發無限重載（2026-09-23 實測 2 分鐘 786 次）。要驗證就
  `wrangler deploy` 到 workers.dev 預覽網址看。

- **`wrangler.jsonc` 不給 Prettier 排版**（已在 `.prettierignore`）。Prettier
  會在 jsonc 補尾逗號，排版換不到可讀性，解析失敗卻會讓全站上不了線。

- **改完跑 `npm run check`，有畫面風險的改動再跑 `npm run test:visual` 比對**。

## 部署（Cloudflare Workers Static Assets，git push 自動部署）

- 正式站：`https://sim.ark-blueprint.com`（GitHub Actions → `wrangler deploy`，
  push main 即自動部署；設定見 `wrangler.jsonc` 與 `.github/workflows/deploy.yml`）
- repo 根目錄就是站台根目錄；哪些檔不該上傳看 `.assetsignore`，回應標頭看 `_headers`
- `data/` 已納入版控；更新標的資料：`npm run fetch` → commit → push
- 舊站 `https://trianingground.web.app`（Firebase Hosting）仍在線上（目前回 301），
  `firebase.json` / `firestore.rules` 留著是為了它；需要時手動
  `npx firebase-tools deploy --only hosting` 同步

### 2. Supabase 一次性設定（主站專案 `bvmeeupxhbrwtrmuyhqq`）

1. **套用 migration**：主站 repo 的 `supabase/migrations/0067_tradersim_states.sql`
   貼到 Supabase Dashboard → SQL Editor 執行（冪等，可重跑）
2. **Auth Redirect URLs**：Dashboard → Authentication → URL Configuration →
   Redirect URLs 加入：
   - `https://trianingground.web.app`
   - `http://localhost:8081`（本機開發）

### 3. 學員權限

不用設定。學員在方舟藍圖是有效訂閱會員（starter/vip/pro/private 未過期）
就能登入練功房；教練/管理員（`admin_users`）一律放行。

## 資料結構（Supabase `tradersim_states`，每學員一列）

```
user_id       → auth.users（方舟同一帳號）
email, display_name                # 反正規化供後台列表
state (jsonb)                      # 完整模擬器狀態：
  ├ trades[]                       #   已平倉（盲測交易帶 blindId 與點值快照 pv）
  ├ positions[] / settings
  ├ drawings / indicators / drawTemplates / activeTplId
  └ blind { active, history[] }    #   進行中盲測 + 盲測歷史
summary (jsonb)                    # 績效摘要（交易數/勝率/盈虧/平均R/盲測場數）
updated_at
```

RLS：學員只能讀寫自己那列；admin 可讀全部（後台檢視）。

## 資料來源

- 加密貨幣: Binance REST API
- 美股 / 台股 / NQ: Yahoo Finance（日線完整、1H 限近 ~720 天）
- TXF 日線: FinMind（TX 連續近月期貨）
- TXF 1H: Yahoo Finance ^TWII（加權指數作為 proxy）
- 台股價格為 TWD，金額按 31 TWD/USD 概略換算（`fetch-data.mjs` 的 `TWD_USD`）
