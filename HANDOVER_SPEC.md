# 專案開工需求規格書：SEPA × VCP 跨市場自動化選股與監控系統

## 1. 專案目標與交易核心鐵律
建構一套支援 **台股（TW）** 與 **美股（US）** 的自動化交易分析系統，嚴格執行 Mark Minervini 的 SEPA / VCP 策略。

### 開發必須遵守的三條鐵律（Guardrails）
1. **禁止 LLM 直接計算技術指標**：所有均線、RS 線、BBW 百分位、ATR、ADR%、量比與口袋支點，一律由 `core/calc_vcp_metrics.py` 計算並輸出精簡 JSON；AI（`vcp-stock-analysis` Skill）僅讀取 JSON 摘要進行型態判讀與戰術決策。
2. **歷史數據必須還原權息（Adjusted Price）**：禁止使用未還原除權息的歷史 K 棒計算均線與布林帶寬（如 Shioaji 原生未還原 `kbars`），避免除息跳空造成 VCP 破線誤判。
3. **拒絕落後震盪指標**：核心決策嚴禁引入 KD、RSI、MACD 作為進場濾網，一切以價格、成交量、均線結構與波動率為準。

---

## 2. 系統架構與三引擎分工（Adapter Pattern）

所有外部資料源必須透過 `adapters/` 轉換為統一格式（Standard OHLCV DataFrame：`date, open, high, low, close, volume`），核心運算層 `core/` 保持 100% 市場無關。

| 模組 / MCP | 負責市場 | 核心職責 | 注意事項 |
| :--- | :--- | :--- | :--- |
| **TradingView MCP** | 台股＋美股 | 全市場 Stage 2 初篩（Screener）、台股還原權息歷史日 K | 僅用於盤後海選與歷史 K 棒，不作為盤中即時下單依據 |
| **永豐 Shioaji MCP** | 台股 | 盤中即時報價訂閱（僅限 Focus List 5～15 檔）、預估量計算、突破預警 | **嚴禁**拿 Shioaji 掃全市場 1,800 檔歷史 K 棒 |
| **富途 Futu MCP** | 美股 | 美股前復權歷史日 K、基礎財報（EPS/營收/財報日）、美股盤中即時監控 | 需檢查本機 `FutuOpenD` 連線狀態與報價權限 |
| **台股籌碼爬蟲** | 台股 | 抓取證交所／櫃買中心盤後三大法人買賣超、融資餘額、月營收 | 補齊台股第 3 關（機構法人籌碼）數據 |

---

## 3. 專案目錄結構

```text
vcp-trading-system/
├── .agent/skills/vcp-stock-analysis/
│   └── SKILL.md                   # 四關卡 VCP 分析技能書
├── config/
│   ├── markets.yaml               # 台股(60/120/240MA, ^TWII)與美股(50/150/200MA, QQQ/SPY)參數
│   └── watchlists/                # 每日產出的 tw_focus.json / us_focus.json
├── adapters/
│   ├── tv_screener.py             # TradingView MCP 海選與還原日K介面
│   ├── shioaji_client.py          # 永豐 Shioaji 盤中即時行情與預估量
│   ├── futu_client.py             # 富途 OpenD 美股前復權日K、財報與即時行情
│   └── tw_chips_fetcher.py        # 台股三大法人、融資與月營收補強
├── core/
│   ├── calc_vcp_metrics.py        # 【核心】四大關卡硬指標運算引擎（已提供基準碼）
│   └── risk_manager.py            # 帳戶總資金 1% 單筆風險反推部位股數與停損管理
├── runners/
│   ├── run_single_stock.py        # 模式 A：指定單股深度健檢 (CLI: --symbol NVDA --market US)
│   ├── run_post_market_scan.py    # 模式 B：盤後全市場漏斗海選 (CLI: --market TW / US)
│   └── run_intraday_radar.py      # 模式 C：盤中 Focus List 樞紐點即時雷達
└── data/
    ├── cache/                     # 歷史 OHLCV 本地 CSV 快取
    └── reports/                   # 每日 JSON 指標摘要與 Markdown 交易計畫
```

---

## 4. 三大核心工作流規格

### 工作流 A：指定股票深度診斷（`run_single_stock.py`）
1. 接收 `symbol` 與 `market`（TW / US）。
2. 自動抓取該股近 300 日還原 OHLCV、對應大盤指數（`^TWII` 或 `QQQ`），以及選填的基本面／籌碼資料。
3. 呼叫 `core/calc_vcp_metrics.py` 產出標準 JSON。
4. 觸發 `vcp-stock-analysis` Skill 讀取 JSON，輸出 A/B/C 評級與明確 Pivot／停損價位。

### 工作流 B：盤後全市場海選漏斗（`run_post_market_scan.py`）
1. **初篩（TradingView Screener）**：篩選 `Price > MA50 > MA150 > MA200`（台股對應 60/120/240）、距 52 週高點 <= 25%、高於 52 週低點 >= 30%、流動性達標，將數千檔壓縮至 40～80 檔。
2. **精算（`calc_vcp_metrics.py`）**：批次計算 RS 線創高、BBW 120 日百分位 <= 25%、`ATR(5)/ATR(20) <= 0.75`、VDU 或近 5 日口袋支點。
3. **財報防雷（美股）**：若 `next_earnings_date` 距今 <= 7 個交易日，自動標記 `EARNINGS_WARNING` 並降級。
4. **產出**：濃縮出 5～15 檔寫入 `config/watchlists/{tw|us}_focus.json`，供 AI 產生隔日作戰清單與盤中雷達訂閱。

### 工作流 C：盤中樞紐點即時監控（`run_intraday_radar.py`）
- **訂閱對象**：僅讀取 `watchlists/{tw|us}_focus.json` 中評級為 A / B 的標的。
- **雙重觸發條件**：
  1. `即時價 >= suggested_pivot`
  2. `預估全日成交量 >= 50日均量 * 1.5`（美股於開盤 15 分鐘後才啟動量能推估，避開開盤雜訊）。
- **通知輸出**：觸發時推送警報（含代號、觸發價、預估量比、預設停損價、依 1% 風險計算的建議股數）。

---

## 5. 分階段開發里程碑與驗收標準

- **Phase 1（單股閉環）**：建立專案骨架、部署 `core/calc_vcp_metrics.py`、接通 TradingView MCP 與 Futu MCP 歷史日 K，完成 `run_single_stock.py`。
  - *驗收*：輸入 `2330`（TW）與 `NVDA`（US），5 秒內產出無報錯的標準 JSON 與四關卡分析報告。
- **Phase 2（盤後海選漏斗）**：完成 TradingView Screener 批次初篩、台股法人籌碼補強與美股財報日欄位，跑通 `run_post_market_scan.py`。
  - *驗收*：可透過排程（06:15 美股 / 15:30 台股）自動產出 5～15 檔 Focus List JSON。
- **Phase 3（盤中即時雷達與風控）**：接通 Shioaji MCP（台股）與 Futu MCP（美股）即時報價，整合 `risk_manager.py` 完成 `run_intraday_radar.py`。
  - *驗收*：模擬觸價與量能條件時，能即時正確計算預估量並發送風控警報。
