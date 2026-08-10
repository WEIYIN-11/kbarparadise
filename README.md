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
| 類別 | 日線 | 1 小時 |
|---|---|---|
| BTC | 2020-01-01 ~ 今日 | 2020-01-01 ~ 今日 |
| ETH / SOL | 2020 (SOL 為上市日) ~ 今日 | 近 720 天 |
| NQ / TXF | 2020-01-01 ~ 今日 | 約最近 2 年 |
| 其他加密 / 美股 / 台股 | 2020-01-01（或上市日）~ 今日 | —（無 1H） |

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

### 雲端同步（Firebase）
- Google 帳號登入
- Email 白名單（教練透過 Firebase console 維護）
- 跨裝置同步：交易、畫線、指標設定、模板都即時上雲

## 開發指令
```bash
# 抓取最新歷史資料
npm run fetch

# 本機啟動（需 Node）
npm run serve
# 開 http://localhost:8081
```

## 部署到 Firebase Hosting

### 1. 安裝 Firebase CLI（一次即可）
```bash
npm install -g firebase-tools
firebase login
```

### 2. 部署 Firestore 規則
```bash
firebase deploy --only firestore:rules
```

### 3. 部署網站
```bash
firebase deploy --only hosting
```

部署後網址：`https://trianingground.web.app`

### 4. 加入學員到白名單
1. 開 [Firebase Console](https://console.firebase.google.com/) → 選 `trianingground` 專案
2. Firestore Database → 開始集合 `whitelist`
3. 每位學員建立一個文件：
   - **Doc ID**：學員 email（小寫，例：`student@gmail.com`）
   - **欄位**：可留空，或加 `name: "張三"` `joinedAt: 時間`

### 5. 啟用 Google 登入
1. Firebase Console → Authentication → Sign-in method
2. 啟用 **Google** 提供者
3. Authorized domains 加入：
   - `localhost`（本機測試）
   - `trianingground.web.app`（正式網址）
   - 自訂網域（如有）

## 資料結構（Firestore）

```
/whitelist/{email}                # 白名單（教練手動維護）
/users/{uid}/sim/state            # 學員所有資料（單一文件）
  ├ trades[]                      # 已平倉紀錄（盲測交易帶 blindId 與點值快照 pv）
  ├ positions[]                   # 未平倉
  ├ settings { balance }
  ├ drawings { 'NQ_1h': [...], 'BTC_1d': [...] }
  ├ indicators { ema, bb, volume, rsi, macd }
  ├ drawTemplates { trend, hline, rect, fib }
  ├ activeTplId { ... }
  └ blind { active, history[] }   # 進行中盲測 + 盲測歷史
/shares/{shareId}                 # （未來）教練分享連結
```

## 資料來源
- 加密貨幣: Binance REST API
- 美股 / 台股 / NQ: Yahoo Finance（日線完整、1H 限近 ~720 天）
- TXF 日線: FinMind（TX 連續近月期貨）
- TXF 1H: Yahoo Finance ^TWII（加權指數作為 proxy）
- 台股價格為 TWD，金額按 31 TWD/USD 概略換算（`fetch-data.mjs` 的 `TWD_USD`）
