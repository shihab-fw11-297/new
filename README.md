# XAUUSD Market Chart

Phase 1 candle data foundation and chart rendering for XAUUSD/market data.

The app fetches candles server-side from Finage, normalizes the provider response,
deduplicates and sorts by timestamp, audits the dataset, and renders a clean
candlestick chart.

## Getting Started

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3015](http://localhost:3015) with your browser to see the result.

If an older development instance from this project is still running, the command
stops it before starting a fresh server. Other applications using the port are
left untouched.

To run the optimized production server on port 3000, use:

```bash
npm start
```

This command creates a fresh production build before starting the server.

## Finage Configuration

Add the API key in `.env.local`:

```bash
CANDLE_API_PROVIDER=finage
CANDLE_API_KEY=your_finage_key
CANDLE_API_MAX_POINTS=30000
```

The server route maps app timeframes to Finage aggregate endpoints:

- `1m` -> `/agg/forex/{symbol}/1/minute/{start}/{end}`
- `5m` -> `/agg/forex/{symbol}/5/minute/{start}/{end}`
- `15m` -> `/agg/forex/{symbol}/15/minute/{start}/{end}`
- `1h` -> `/agg/forex/{symbol}/1/hour/{start}/{end}`

The API key is only read in the server-side route and is not exposed to the client bundle.

## Checks

```bash
pnpm test
pnpm lint
pnpm build
```
