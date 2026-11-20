# SEPA × VCP 跨市場自動化選股與監控系統 — 待辦與開發藍圖（ROADMAP）

> 最後更新：2026-11-21（v0.2 里程碑）  
> 核心規範與三大開發鐵律請參閱 [HANDOVER_SPEC.md](../HANDOVER_SPEC.md)。

---

## 1. 目前已完成進度（v0.2 Snapshot）

### Phase 1：單股深度健檢閉環
- **核心量化引擎**：保留 [core/calc_vcp_metrics.py](../core/calc_vcp_metrics.py)、[config/markets.yaml](../config/markets.yaml) 與 [.agent/skills/vcp-stock-analysis/SKILL.md](../.agent/skills/vcp-stock-analysis/SKILL.md) 基準邏輯。
- **統一資料介面（`adapters/`）**：
  - [adapters/base.py](../adapters/base.py)：標準化 `date, open, high, low, close, volume` OHLCV 格式與本地 CSV 快取。
  - [adapters/futu_client.py](../adapters/futu_client.py)：串接官方 `futu` CLI（`futu history-kline --autype 1` 前復權 QFQ），並保留本地 FutuOpenD（1 秒 TCP 快檢）、TradingView 快取與備援路徑。
  - [adapters/tv_screener.py](../adapters/tv_screener.py)：實作台股還原權息（含除權＋除息，Yahoo v8 Chart API `adjclose / close`）日 K 抓取，並保留 TradingView MCP 匯入介面（`import_mcp_bars` / `import_mcp_output.py`）。
- **單股執行器**：[runners/run_single_stock.py](../runners/run_single_stock.py) 支援 `--symbol` / `--market`（TW / US）產出標準四關卡指標 JSON。

### Phase 2：盤後全市場海選漏斗、籌碼補強與通知
- **全市場 Stage 2 初篩**：`run_stage2_screener()` 透過 TradingView Scanner API 執行美股（`50/150/200MA`）與台股初篩，結合 52 週高低位階與流動性條件。
- **第 3 關催化劑與籌碼補強**：
  - [adapters/tw_chips_fetcher.py](../adapters/tw_chips_fetcher.py)：整合證交所（TWSE `T86`、`MI_MARGN`、`t187ap05_L`）與櫃買中心（TPEx 三大法人、融資融券、月營收），提供上市 1 日／5 日法人買賣超、投信連買天數、融資融券增減與月營收 YoY/MoM。
  - 美股防雷與季報成長：`build_us_catalysts()` 與 `_fetch_futu_quarterly_growth()` 計算距下次財報日交易天數（`<= 7` 日自動標記 `EARNINGS_WARNING` 並降級），並讀取 `futu financials` 最新一季營收與 EPS 成長率。
- **台股與通知優化**：
  - 雙層排除興櫃（OES）：海選層透過 TWSE/TPEx 主板清單（`is_tw_listed_or_otc`）排除，執行層由 Shioaji 合約檢查擋下 `OES`。
  - 繁體中文股票名稱（`name_zh`）：台股取自官方 TWSE/TPEx；美股透過 `futu basicinfo`（`tc_name`）批次快取取得，同步顯示於 `focus.json`、終端機表格與 Telegram 通知。
  - Telegram 推播（[adapters/telegram_notifier.py](../adapters/telegram_notifier.py)）：支援多聊天室逗號分隔 `TG_CHAT_ID`、`--bind-group` 自動偵測群組事件（已綁定 `VCPNotify` 群組），及 `--send-focus`／`--notify`。
- **永豐 Shioaji 唯讀即時介面**：[adapters/shioaji_client.py](../adapters/shioaji_client.py) 支援官方 `SJ_*` 與 `SHIOAJI_*` 環境變數、Focus List 20 檔上限防護、盤中即時 Tick 訂閱（濾除試撮與盤中零股）、開盤前 5 分鐘延遲與全日預估量比（張轉股 `× 1000`）計算。
- **排程註冊腳本**：[scripts/register_schedules.ps1](../scripts/register_schedules.ps1) 提供美股 `06:15` 與台股 `15:30` Windows Task Scheduler 註冊／Dry-Run 管理。

---

## 2. Phase 3：盤中即時雷達與風控（下一階段核心）

- [ ] **建立 `core/risk_manager.py`（1% 單筆風險與部位控管）**
  - 依帳戶總資金與 `config/markets.yaml` 的 `account_risk_per_trade_pct`（預設 `1.0%`）及 `max_stop_loss_pct`（`8.0%`），由 `suggested_pivot` 與 `suggested_stop_loss` 反推建議買進股數／台股張數。
  - 加入總持股曝險上限、單筆最大資金上限與美股／台股最小交易單位取整（台股 1,000 股／1 張或零股切換；美股 1 股）。
- [ ] **建立 `runners/run_intraday_radar.py`（盤中即時樞紐點雷達）**
  - 僅讀取 `config/watchlists/{tw|us}_focus.json` 中評級為 `A` / `B`（或可設定之評級門檻）的標的，嚴格控制訂閱數量。
  - **雙引擎即時行情**：
    - 台股：透過 `ShioajiClient.subscribe_ticks()` 監聽即時成交，並遵循 `intraday_volume_estimate_delay_minutes: 5` 推算全日預估量。
    - 美股：串接 `futu` 即時報價或 OpenAPI Quote Push WebSocket（`wss://webapi-quote.futunn.com/ws`），遵循 `15` 分鐘開盤延遲避開開盤爆量雜訊。
  - **雙重觸發與警報去重**：當 `即時價 >= suggested_pivot` 且 `預估全日成交量 >= vol_ma50 * 1.5` 時，呼叫 `format_intraday_breakout_alert()` 推播至 Telegram（含部位股數與停損金額），並實作當日單一標的冷卻／去重機制避免洗版。
  - **模擬回放驗收模式（`--simulate`）**：支援帶入模擬 Tick／時間點驗證雙重觸發、開盤延遲窗與 1% 風控股數計算，不需等到開盤即可完整驗收。

---

## 3. 台股數據與選股深化（TW 強化）

- [ ] **上櫃（TPEx）多日法人買賣超累積**：目前櫃買中心 OpenAPI 僅提供最新 1 日三大法人數據；須規劃歷史抓取或每日累計快取，補齊上櫃股 5 日／10 日投信與外資買賣超及連買天數。
- [ ] **集保（TDCC）股權分散與大戶籌碼**：抓取集保中心每週 400 張／1000 張以上大戶持股比例變化，補齊 `SKILL.md` 第 3 關「大戶增持、散戶與融資減少」驗證。
- [ ] **台股季報 EPS 與毛利率加速（Code 33）**：串接公開資訊觀測站（MOPS）或財務報表資料源，補齊台股近 2～3 季 EPS YoY、營收 YoY 與毛利率變化。
- [ ] **第 1 關市場廣度與族群共振指標**：盤後海選納入「全市場創 52 週新高／新低家數比」以及「同產業／同族群處於 Stage 2 家數」，區分孤軍奮戰與主流族群集體突破。
- [ ] **處置股／注意股濾網與契約 API 更新**：
  - 盤後／盤中濾除分盤處置股（避免 5 分／20 分撮合導致流動性與預估量失真）。
  - 將 `adapters/shioaji_client.py` 的 `self.api.Contracts` 更新為新版 `self.api.contracts`，消除 `shioaji 1.7.7` 的 `DeprecationWarning`。

---

## 4. 美股與資料源穩定性優化（US & Infra）

- [ ] **`futu` CLI 批次節流與錯誤退避**：在 `run_post_market_scan.py`／`futu_client.py` 對 `futu history-kline` 加入併發速率限制與自動 retry/backoff（429 / `RATE_LIMIT`），避免同時 4 執行緒冷抓時觸發限流。
- [ ] **升級 `futu_client.py` 的 Yahoo 備援層**：目前本機 `yfinance 0.2.49` 易出現空資料或 JSON 解析失敗，將 `_yf_history()` 改為直接使用穩定的 Yahoo Finance v8 Chart API（含 `adjclose` 還原），與台股 `tv_screener.py` 一致。
- [ ] **美股中文名稱繁簡統一**：少數標的（如 `MRSH 达信`）在 Futu `basicinfo` 的 `tc_name` 仍回傳簡體字，可評估加入輕量簡轉繁對照或 OpenCC 選配轉換。
- [ ] **盤後自動產出 AI 戰情簡報**：結合 `vcp-stock-analysis` Skill，每日盤後自動對 Focus List 前 3～5 名生成結構化 Markdown 交易計畫存於 `data/reports/`。

---

## 5. 維運、排程與測試自動化

- [ ] **正式啟用每日排程與異常告警**：
  - 確認權限與環境後執行 `powershell -ExecutionPolicy Bypass -File scripts/register_schedules.ps1 -Register` 正式掛載 `06:15`（US）／`15:30`（TW）排程。
  - 為排程腳本加上執行日誌落盤（`data/reports/logs/`）與非零退出碼自動推播錯誤通知至 Telegram。
- [ ] **補齊 `requirements.txt` 與自動化測試套件（`tests/`）**：
  - 建立乾淨的 `requirements.txt`（`pandas`、`numpy`、`pyyaml`、`shioaji`、`futu-api` 等版本鎖定）。
  - 將散落於各模組 `--selftest` 整併為 `pytest` 單元測試（涵蓋 `calc_vcp_metrics` 邊界值、財報 7 日防雷降級、`estimate_tw_full_day_volume` 單位換算、`is_tw_listed_or_otc` 過濾、Telegram HTML 跳脫與分片）。
- [ ] **突破訊號事後追蹤（Post-Alert Journal）**：記錄每次突破警報當下價量與 5 日／20 日後報酬、是否觸及停損，作為濾網與評分權重回測調整依據。
- [ ] **人工確認式模擬下單預覽（選配）**：確認風控穩定後，可依 Shioaji CA 憑證／Futu 模擬倉串接 **Dry-Run 試算確認單**（預設僅產出委託預覽，須人工明確確認才送單）。
