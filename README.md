# actual-stocks

Daily mark-to-market updater for ETF/stock holding transactions in [Actual Budget](https://actualbudget.org).

Tag a transaction's note with a quantity and ticker (e.g. `5 WPEA`) and this script will look up
the current price on Yahoo Finance and rewrite the transaction's `amount` to `quantity x price`,
so the transaction (and the account balance) always reflects today's market value.

## How it works

1. Connects to your Actual sync server and downloads the budget.
2. Reads every transaction in each target account.
3. For each transaction whose `notes` matches `<quantity> <TICKER>` (e.g. `5 WPEA`, `1.5 CW8`):
   - Looks up `TICKER` in `tickers.json` to get the data-provider symbol (e.g. `WPEA` -> `WPEA.PA`).
     If there's no mapping, the ticker is used as-is.
   - Fetches the current price from Yahoo Finance.
   - Updates the transaction's `amount` to `quantity x price` (in cents), preserving the original sign.
4. Skips transactions that are part of an Actual **transfer** (have a `transfer_id`) or a **split**
   (have subtransactions), logging a warning instead of touching them — see
   [Buying a holding](#buying-a-holding) below for why transfers are skipped. Splits are skipped
   because the note needs to live on a plain, non-split transaction to be revalued.

## Buying a holding

Don't record a buy using Actual's transfer feature. A transfer is a linked pair of transactions,
and editing the amount on one side also rewrites the other side to keep them equal — so revaluing
the investment-account transaction would silently rewrite how much cash left your checking account.

Instead, enter a buy as two independent, unlinked transactions:

- **Checking account**: a normal outflow, fixed at cost (e.g. category "Investments").
- **Investment account**: a normal inflow with the note `<quantity> <TICKER>`, e.g. `5 WPEA`.

Only the investment-account transaction gets revalued by this script.

Note that the investment-account transaction's amount gets overwritten on every run, so it no
longer reflects what you actually paid. If you want to keep the cost basis around, track it with
a separate zero-amount transaction carrying a note like `Bought 5 WPEA @ 6.50`. A note like that
won't match the `<quantity> <TICKER>` pattern, so the script will never touch it.

## Setup

Requires Node.js 22+.

```bash
npm install
cp .env.example .env
```

Edit `.env` with your Actual server details:

| Variable | Required | Description |
|---|---|---|
| `ACTUAL_SERVER_URL` | yes | URL of your Actual sync server |
| `ACTUAL_PASSWORD` | yes | Actual server password |
| `ACTUAL_SYNC_ID` | yes | Budget sync ID (Settings -> Show advanced settings) |
| `ACTUAL_ENCRYPTION_PASSWORD` | no | Only if the budget file has end-to-end encryption enabled |
| `ACTUAL_ACCOUNT_IDS` | one of these | Comma-separated target account IDs |
| `ACTUAL_ACCOUNT_NAMES` | two | Comma-separated target account names. Merged with `ACTUAL_ACCOUNT_IDS` if both are set |
| `ACTUAL_DATA_DIR` | no | Local budget cache dir. Defaults to `/data` (used by the Docker image) — set to e.g. `./data` when running outside Docker |
| `TICKER_MAP_PATH` | no | Path to the ticker map file. Defaults to `tickers.json` |
| `CRON_SCHEDULE` | no | Docker-only: cron expression for the daily run. Defaults to `0 18 * * *` |
| `RUN_ON_START` | no | Docker-only: also run once immediately when the container starts |
| `DEBUG` | no | Set to `true` to log every scanned transaction's raw note, split/transfer status, and whether it matched — useful for figuring out why a transaction isn't being picked up |

### Ticker mapping

The ticker you write in a transaction's note (e.g. `WPEA`) doesn't have to be the exact symbol a
price provider understands — `tickers.json` maps the short note ticker to whatever symbol Yahoo
Finance actually needs to look it up:

```json
{
  "WPEA": "WPEA.PA"
}
```

If a ticker has no entry in `tickers.json`, the script uses the note ticker as-is, which only
works for symbols Yahoo already resolves without a suffix (mostly US-listed stocks, e.g. `AAPL`).

**Finding the right symbol:** search for the ETF/stock on
[finance.yahoo.com](https://finance.yahoo.com) — the symbol shown on its quote page (e.g.
`WPEA.PA`, `AAPL`, `VWCE.DE`) is what belongs on the right-hand side of the mapping. Yahoo
identifies non-US exchanges with a suffix on the ticker, not a prefix — some common ones:

| Exchange | Suffix | Example |
|---|---|---|
| Euronext Paris | `.PA` | `WPEA.PA` |
| Euronext Amsterdam | `.AS` | `VWRL.AS` |
| Deutsche Börse Xetra | `.DE` | `VWCE.DE` |
| London Stock Exchange | `.L` | `VWRL.L` |
| Borsa Italiana (Milan) | `.MI` | `SWDA.MI` |
| US exchanges (NYSE/Nasdaq) | none | `AAPL` |

A common mistake is using Google Finance's `EXCHANGE:TICKER` syntax (e.g. `EPA:WAVE`) — Yahoo
doesn't understand that format and the quote lookup will fail. Use the suffix form (`WAVE.PA`)
instead.

### Crypto

Crypto works the same way as ETFs — Yahoo Finance quotes crypto pairs like `BTC-USD` or `BTC-EUR`.
Map your note ticker to the pair matching your account's currency:

```json
{
  "WPEA": "WPEA.PA",
  "BTC": "BTC-EUR",
  "ETH": "ETH-EUR"
}
```

A note like `0.05 BTC` works exactly like a stock/ETF holding note. As with ETFs, the script does no
FX conversion, so pick the pair that matches your account's currency (`BTC-EUR` for a EUR account,
`BTC-USD` for a USD account).

## Running locally

```bash
node --env-file=.env src/index.js
```

## Running as a container

The Docker image runs continuously and fires the update on the schedule set by `CRON_SCHEDULE`
(default: every day at 18:00).

```bash
docker compose up -d --build
```

Budget data is cached in `./data` (mounted into the container) so it doesn't need a full
re-download on every run.

`tickers.json` is also mounted (read-only) rather than baked into the image, so you can add new
tickers by editing the file — no rebuild required, just wait for the next scheduled run (or restart
the container to pick it up sooner).
