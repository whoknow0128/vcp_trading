# SEPA × VCP Trading Workbench

Cross-market (**US** & **TW**) Mark Minervini SEPA / VCP stock analysis, post-market funnel scanner, and intraday breakout risk calculator — migrated to Node.js 22 + Express + React (Vite + Tailwind CSS) for AI Studio.

## Features

- **Single-Stock 4-Gate Diagnosis**: Adjusted daily OHLCV (Yahoo Finance v8 `adjclose / close`) or custom CSV upload, interactive Moving Averages / Bollinger Bands / Volume / RS Line charts, and full 4-Gate deterministic SEPA × VCP scoring.
- **Post-Market Funnel Scanner**: Live TradingView Stage 2 screening for US (`50/150/200MA`, `QQQ`) and TW (`60/120/240MA`, `^TWII`), TWSE/TPEx institutional chips & OES exclusion, US 7-trading-day earnings warnings, Focus List ranking, JSON export, and Telegram summary formatting.
- **Intraday Breakout Radar & 1% Risk Sizer**: Dual-condition breakout trigger evaluator (`Price >= Pivot` and `Projected Full-Day Volume >= 1.5× 50D Avg`) with opening delay guards (5 min TW / 15 min US) and 1% account risk position sizing.
- **Market Rules & Configuration**: Reads `config/markets.yaml` and displays active data adapters and environment variable configuration status.

## Scripts

- `npm run dev` — Starts the unified Express + Vite server on `0.0.0.0:3000`.
- `npm run build` — Builds the production frontend bundle into `dist/`.
- `npm run start` — Serves the compiled production app via Node.js on `0.0.0.0:3000`.
- `npm run lint` — Runs TypeScript type-checking and ESLint.