import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '@actual-app/api';
import YahooFinance from 'yahoo-finance2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const yahooFinance = new YahooFinance();

const {
  ACTUAL_SERVER_URL,
  ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID,
  ACTUAL_ENCRYPTION_PASSWORD,
  ACTUAL_ACCOUNT_IDS,
  ACTUAL_ACCOUNT_NAMES,
  ACTUAL_DATA_DIR = '/data',
  TICKER_MAP_PATH = path.join(__dirname, '..', 'tickers.json'),
} = process.env;

// Matches notes like "5 WPEA" or "1.5 CW8"
const NOTE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s+([A-Za-z0-9._-]+)\s*$/;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function loadTickerMap() {
  try {
    return JSON.parse(readFileSync(TICKER_MAP_PATH, 'utf8'));
  } catch (err) {
    console.warn(`No ticker map at ${TICKER_MAP_PATH}, using note tickers as-is (${err.message})`);
    return {};
  }
}

function parseHolding(notes) {
  if (!notes) return null;
  const match = NOTE_PATTERN.exec(notes);
  if (!match) return null;
  return { quantity: Number(match[1]), ticker: match[2].toUpperCase() };
}

function splitList(value) {
  return (value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function resolveAccounts() {
  const wantedIds = splitList(ACTUAL_ACCOUNT_IDS);
  const wantedNames = splitList(ACTUAL_ACCOUNT_NAMES);

  if (wantedIds.length === 0 && wantedNames.length === 0) {
    throw new Error('Set ACTUAL_ACCOUNT_IDS and/or ACTUAL_ACCOUNT_NAMES (comma-separated) to at least one account.');
  }

  const accounts = await api.getAccounts();
  const resolved = new Map();

  for (const id of wantedIds) {
    const account = accounts.find((a) => a.id === id);
    if (!account) {
      throw new Error(`No account with id "${id}" found. Available: ${accounts.map((a) => `${a.name} (${a.id})`).join(', ')}`);
    }
    resolved.set(account.id, account);
  }

  for (const name of wantedNames) {
    const account = accounts.find((a) => a.name === name);
    if (!account) {
      throw new Error(`No account named "${name}" found. Available: ${accounts.map((a) => a.name).join(', ')}`);
    }
    resolved.set(account.id, account);
  }

  return [...resolved.values()];
}

async function fetchPrices(symbols) {
  const prices = {};
  for (const symbol of symbols) {
    const quote = await yahooFinance.quote(symbol);
    if (!quote || typeof quote.regularMarketPrice !== 'number') {
      throw new Error(`No price returned for ${symbol}`);
    }
    prices[symbol] = { price: quote.regularMarketPrice, currency: quote.currency };
  }
  return prices;
}

async function main() {
  requireEnv('ACTUAL_SERVER_URL', ACTUAL_SERVER_URL);
  requireEnv('ACTUAL_PASSWORD', ACTUAL_PASSWORD);
  requireEnv('ACTUAL_SYNC_ID', ACTUAL_SYNC_ID);

  const tickerMap = loadTickerMap();

  await api.init({
    serverURL: ACTUAL_SERVER_URL,
    password: ACTUAL_PASSWORD,
    dataDir: ACTUAL_DATA_DIR,
  });

  try {
    await api.downloadBudget(
      ACTUAL_SYNC_ID,
      ACTUAL_ENCRYPTION_PASSWORD ? { password: ACTUAL_ENCRYPTION_PASSWORD } : undefined,
    );

    const accounts = await resolveAccounts();
    console.log(`Scanning accounts: ${accounts.map((a) => a.name).join(', ')}`);
    const today = new Date().toISOString().slice(0, 10);

    const holdings = [];
    for (const account of accounts) {
      const transactions = await api.getTransactions(account.id, '1970-01-01', today);
      for (const tx of transactions) {
        if (tx.is_parent || (tx.subtransactions && tx.subtransactions.length)) continue;
        const holding = parseHolding(tx.notes);
        if (!holding) continue;
        if (tx.transfer_id) {
          // Transfers are a linked pair: editing this amount would also rewrite
          // the paired transaction in the other account (e.g. the cash outflow
          // in checking). Buys must be entered as two independent transactions,
          // not a transfer, so this one is safe to revalue.
          console.warn(
            `Skipping ${account.name} ${tx.date} "${tx.notes}" (id ${tx.id}): it's a linked transfer, revaluing it would also change the other account's transaction.`,
          );
          continue;
        }
        const symbol = tickerMap[holding.ticker] || holding.ticker;
        holdings.push({ tx, account, ...holding, symbol });
      }
    }

    if (holdings.length === 0) {
      console.log('No transactions with a "<qty> <TICKER>" note found. Nothing to do.');
      return;
    }

    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    console.log(`Fetching prices for: ${symbols.join(', ')}`);
    const prices = await fetchPrices(symbols);

    let updated = 0;
    for (const { tx, account, quantity, ticker, symbol } of holdings) {
      const { price } = prices[symbol];
      const sign = tx.amount < 0 ? -1 : 1;
      const newAmount = sign * Math.round(quantity * price * 100);
      if (newAmount === tx.amount) continue;
      await api.updateTransaction(tx.id, { amount: newAmount });
      updated += 1;
      console.log(
        `${account.name}  ${tx.date}  ${ticker} (${symbol}): ${quantity} x ${price} -> ${(newAmount / 100).toFixed(
          2,
        )} (was ${(tx.amount / 100).toFixed(2)})`,
      );
    }

    console.log(`Done. Updated ${updated}/${holdings.length} holding transaction(s).`);
  } finally {
    await api.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
