# 練功房 (TraderSim)

交易模擬訓練工具：用歷史 K 棒練習進出場時機，回放、模擬下單、彙整績效報告給教練檢討。

## 標的
- **NQ** Nasdaq 100 期貨
- **BTC** 比特幣
- **TXF** 台指期（用 ^TWII 加權指數作為走勢替代）

## 資料涵蓋
| 標的 | 日線 | 1 小時 |
|---|---|---|
| BTC | 2020-01-01 ~ 今日 | 2020-01-01 ~ 今日 |
| NQ | 2020-01-01 ~ 今日 | 約最近 2 年（Yahoo 限制） |
| TXF | 2020-01-01 ~ 今日 | 約最近 2 年（Yahoo 限制） |

## 主要功能

### 圖表 / 回放
- 雙週期：1H / 1D
- K 棒回放（◀ ▶ 速度滑桿、跳轉日期）
- 空白鍵 / 方向鍵控制
- 時間軸可隱藏

### 畫圖工具
- 趨勢線、水平線、矩形、斐波那契
- **模板系統**：每個工具可儲存多組樣式預設（顏色、線寬、線型、標籤）
- 內建模板：支撐、壓力、目標價、需求區、供給區…
- 點擊圖形可選取、拖曳錨點重塑或整體平移

### 模擬交易
- 多空下單，自動依風險％計算部位大小
- SL/TP 線可直接拖曳，金額即時更新
- SL 可拉到進場價之上鎖利（限制不能超過當前價）
- 「策略標籤 × 出場原因」交叉表，揭露紀律破口

### 技術指標
- **疊加在主圖**：EMA × 4 條（可自訂週期/顏色）、布林通道、成交量
- **獨立子圖**：RSI（30/50/70 參考線）、MACD（含柱狀圖）

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
  ├ trades[]                      # 已平倉紀錄
  ├ positions[]                   # 未平倉
  ├ settings { balance }
  ├ drawings { 'NQ_1h': [...], 'BTC_1d': [...] }
  ├ indicators { ema, bb, volume, rsi, macd }
  ├ drawTemplates { trend, hline, rect, fib }
  └ activeTplId { ... }
/shares/{shareId}                 # （未來）教練分享連結
```

## 資料來源
- BTC: Binance REST API
- NQ: Yahoo Finance（日線完整、1H 限近 ~720 天）
- TXF 日線: FinMind（TX 連續近月期貨）
- TXF 1H: Yahoo Finance ^TWII（加權指數作為 proxy）
