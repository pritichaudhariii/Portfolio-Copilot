import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Account,
  Holding,
  PortfolioData,
  TargetAllocation,
  Transaction,
  TransactionType,
  WatchlistItem
} from "../types.js";
import { DEFAULT_DATA_DIR, SEED_DIR } from "../paths.js";

export class PortfolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioError";
  }
}

export interface RecordTransactionInput {
  accountId: string;
  symbol: string;
  type: TransactionType;
  quantity: number;
  price: number;
  date?: string;
  note?: string;
}

/**
 * Internal data source #1: the portfolio ledger.
 *
 * Backed by a JSON file so that writes (trades, watchlist edits, target changes)
 * persist across restarts. On first run the file is seeded from `data/seed/portfolio.json`.
 * Swap the file I/O for a database client without changing the public methods.
 */
export class PortfolioStore {
  private data: PortfolioData;
  private readonly file: string;

  constructor(options: { dataDir?: string; seedFile?: string; inMemory?: boolean } = {}) {
    const dataDir = options.dataDir ?? process.env.DATA_DIR ?? DEFAULT_DATA_DIR;
    const seedFile = options.seedFile ?? path.join(SEED_DIR, "portfolio.json");
    this.file = options.inMemory ? "" : path.join(dataDir, "portfolio.json");

    if (options.inMemory || !fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(seedFile, "utf8")) as PortfolioData;
      if (!options.inMemory) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.persist();
      }
    } else {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8")) as PortfolioData;
    }
  }

  // ---- Reads --------------------------------------------------------------

  getAccounts(): Account[] {
    return structuredClone(this.data.accounts);
  }

  getAccount(accountId: string): Account {
    const account = this.data.accounts.find((a) => a.id === accountId);
    if (!account) {
      throw new PortfolioError(
        `Unknown account "${accountId}". Known accounts: ${this.data.accounts.map((a) => a.id).join(", ")}`
      );
    }
    return structuredClone(account);
  }

  getHoldings(accountId?: string): Holding[] {
    if (accountId) this.getAccount(accountId);
    return structuredClone(
      this.data.holdings.filter((h) => (accountId ? h.accountId === accountId : true) && h.quantity > 0)
    );
  }

  getTransactions(filter: { accountId?: string; symbol?: string; from?: string; to?: string; limit?: number } = {}): Transaction[] {
    const { accountId, symbol, from, to, limit } = filter;
    const rows = this.data.transactions
      .filter((t) => !accountId || t.accountId === accountId)
      .filter((t) => !symbol || t.symbol === symbol.toUpperCase())
      .filter((t) => !from || t.date >= from)
      .filter((t) => !to || t.date <= to)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return structuredClone(limit ? rows.slice(0, limit) : rows);
  }

  getTargetAllocation(): TargetAllocation {
    return structuredClone(this.data.targetAllocation);
  }

  getWatchlist(): WatchlistItem[] {
    return structuredClone(this.data.watchlist);
  }

  // ---- Writes -------------------------------------------------------------

  recordTransaction(input: RecordTransactionInput): Transaction {
    const account = this.getAccount(input.accountId);
    const symbol = input.symbol.toUpperCase();
    const date = input.date ?? todayISO();

    if (!(input.quantity > 0)) throw new PortfolioError("quantity must be greater than zero");
    if (!(input.price >= 0)) throw new PortfolioError("price must be zero or greater");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PortfolioError("date must be YYYY-MM-DD");

    const cash = this.holding(account.id, "CASH");
    const position = this.holding(account.id, symbol);

    switch (input.type) {
      case "buy": {
        if (symbol === "CASH") throw new PortfolioError("Use a deposit to add cash");
        const cost = input.quantity * input.price;
        if (cash.quantity + 1e-6 < cost) {
          throw new PortfolioError(
            `Insufficient cash in ${account.name}: need $${cost.toFixed(2)}, have $${cash.quantity.toFixed(2)}`
          );
        }
        cash.quantity = round2(cash.quantity - cost);
        cash.costBasis = cash.quantity;
        position.quantity += input.quantity;
        position.costBasis = round2(position.costBasis + cost);
        break;
      }
      case "sell": {
        if (symbol === "CASH") throw new PortfolioError("Use a withdrawal to remove cash");
        if (position.quantity + 1e-9 < input.quantity) {
          throw new PortfolioError(
            `Cannot sell ${input.quantity} ${symbol}: ${account.name} holds ${position.quantity}`
          );
        }
        const avgCost = position.quantity > 0 ? position.costBasis / position.quantity : 0;
        position.costBasis = round2(position.costBasis - avgCost * input.quantity);
        position.quantity = round6(position.quantity - input.quantity);
        cash.quantity = round2(cash.quantity + input.quantity * input.price);
        cash.costBasis = cash.quantity;
        break;
      }
      case "dividend": {
        cash.quantity = round2(cash.quantity + input.quantity * input.price);
        cash.costBasis = cash.quantity;
        break;
      }
      case "deposit": {
        cash.quantity = round2(cash.quantity + input.quantity * input.price);
        cash.costBasis = cash.quantity;
        break;
      }
      case "withdrawal": {
        const amount = input.quantity * input.price;
        if (cash.quantity + 1e-6 < amount) {
          throw new PortfolioError(`Insufficient cash to withdraw $${amount.toFixed(2)}`);
        }
        cash.quantity = round2(cash.quantity - amount);
        cash.costBasis = cash.quantity;
        break;
      }
    }

    const txn: Transaction = {
      id: `txn_${randomUUID().slice(0, 8)}`,
      accountId: account.id,
      symbol: input.type === "deposit" || input.type === "withdrawal" ? "CASH" : symbol,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      date,
      ...(input.note ? { note: input.note } : {})
    };
    this.data.transactions.push(txn);
    this.data.holdings = this.data.holdings.filter((h) => h.quantity > 0 || h.symbol === "CASH");
    this.persist();
    return structuredClone(txn);
  }

  updateWatchlist(changes: { add?: Array<{ symbol: string; note?: string }>; remove?: string[] }): WatchlistItem[] {
    for (const item of changes.add ?? []) {
      const symbol = item.symbol.toUpperCase();
      const existing = this.data.watchlist.find((w) => w.symbol === symbol);
      if (existing) {
        if (item.note) existing.note = item.note;
      } else {
        this.data.watchlist.push({ symbol, addedOn: todayISO(), ...(item.note ? { note: item.note } : {}) });
      }
    }
    const remove = new Set((changes.remove ?? []).map((s) => s.toUpperCase()));
    this.data.watchlist = this.data.watchlist.filter((w) => !remove.has(w.symbol));
    this.persist();
    return this.getWatchlist();
  }

  setTargetAllocation(target: TargetAllocation): TargetAllocation {
    const total = Object.values(target.targets).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new PortfolioError(`Target allocation must sum to 100%, got ${total.toFixed(2)}%`);
    }
    this.data.targetAllocation = structuredClone(target);
    this.persist();
    return this.getTargetAllocation();
  }

  /** Restore the seed dataset (used by the `reset_demo_data` tool and tests). */
  reset(seedFile = path.join(SEED_DIR, "portfolio.json")): void {
    this.data = JSON.parse(fs.readFileSync(seedFile, "utf8")) as PortfolioData;
    this.persist();
  }

  // ---- Internals ----------------------------------------------------------

  private holding(accountId: string, symbol: string): Holding {
    let h = this.data.holdings.find((x) => x.accountId === accountId && x.symbol === symbol);
    if (!h) {
      h = { accountId, symbol, quantity: 0, costBasis: 0 };
      this.data.holdings.push(h);
    }
    return h;
  }

  private persist(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export function todayISO(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
