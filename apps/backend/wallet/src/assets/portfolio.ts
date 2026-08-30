/**
 * Asset portfolio — Issue #108.
 *
 * Assembles a full account portfolio (native balance + all asset balances
 * with spam filtering) with an aggressive Redis cache so the portfolio API
 * comfortably stays under the 200ms acceptance target. An optional price
 * provider can enrich the portfolio with a total US value.
 */
import type { Portfolio, AssetBalance, AssetReference } from "@delegolabs/types";
import { createLogger } from "@delegolabs/utils";
import { readAssetServiceConfig } from "./config.js";
import {
  assetKey,
  horizonBalanceToReference,
  type HorizonBalance,
} from "./utils.js";
import { getAccountBalances, type BalancesDeps } from "./balances.js";
import { hasPublishedMetadata } from "./metadata.js";
import { createSpamFilter } from "./spamFilter.js";
import { getRedisConnection } from "../queue/txQueue.js";

const log = createLogger("wallet:assets:portfolio", process.env.LOG_LEVEL ?? "info");
const memoryCache = new Map<string, { value: Portfolio; expiresAt: number }>();

export interface PortfolioDeps extends BalancesDeps {
  /** Optional US~ price lookup (code, issuer) -> USD price. */
  priceProvider?: (code: string, issuer: string) => Promise<number | null>;
}

function balanceToReference(balance: AssetBalance): AssetReference {
  const asset = balance.asset;
  return { code: asset.code, issuer: asset.issuer, type: asset.type };
}

/**
 * Evaluate spam verdict per asset key using the active, configurable
 * spam filter. Exported so the balances endpoint can surface verdicts.
 */
export async function classifySpam(
  balances: AssetBalance[],
  deps: PortfolioDeps = {},
): Promise<Record<string, { isSpam: boolean; reason: string | null }>> {
  const filter = createSpamFilter();

  const verdicts: Record<string, { isSpam: boolean; reason: string | null }> = {};
  for (const balance of balances) {
    const asset = balance.asset;
    const key = assetKey(asset);
    if (asset.type === "native") {
      verdicts[key] = { isSpam: false, reason: null };
      continue;
    }
    if (asset.type === "liquidity_pool") {
      verdicts[key] = { isSpam: false, reason: null };
      continue;
    }
    const hasMeta = await hasPublishedMetadata(asset.code, asset.issuer, deps.discovery);
    const result = filter.evaluate(balanceToReference(balance), { hasMetadata: hasMeta });
    verdicts[key] = { isSpam: result.isSpam, reason: result.reason };
  }
  return verdicts;
}

async function readCached(address: string): Promise<Portfolio | null> {
  const mem = memoryCache.get(address);
  if (mem && mem.expiresAt > Date.now()) return mem.value;
  try {
    const redis = getRedisConnection();
    const raw = await redis.get(`assets:portfolio:${address}`);
    if (raw) {
      const value = JSON.parse(raw) as Portfolio;
      memoryCache.set(address, { value, expiresAt: Date.now() + 60_000 });
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(address: string, portfolio: Portfolio, ttlSeconds: number): Promise<void> {
  memoryCache.set(address, { value: portfolio, expiresAt: Date.now() + ttlSeconds * 1000 });
  try {
    const redis = getRedisConnection();
    await redis.set(`assets:portfolio:${address}`, JSON.stringify(portfolio), "EX", ttlSeconds);
  } catch {
    // in-memory cache remains the source of truth during Redis outages
  }
}

/**
 * Build (or read from cache) the portfolio for an address. Spam assets are
 * excluded when the filter is enabled and set to filter unlisted assets.
 */
export async function getPortfolio(
  address: string,
  deps: PortfolioDeps = {},
): Promise<Portfolio> {
  const config = readAssetServiceConfig();

  const cached = await readCached(address);
  if (cached) return cached;

  const result = await getAccountBalances(address, deps);
  let assetBalances = result.balances;

  const filter = createSpamFilter();
  if (filter.settings.enabled && filter.settings.filterUnlisted) {
    const verdicts = await classifySpam(assetBalances, deps);
    const filtered = assetBalances.filter((b) => {
      const v = verdicts[assetKey(b.asset)];
      if (!v) return true;
      return !v.isSpam;
    });
    if (filtered.length !== assetBalances.length) {
      log.info("Spam filter removed assets from portfolio", {
        address,
        removed: assetBalances.length - filtered.length,
      });
    }
    assetBalances = filtered;
  }

  const portfolio: Portfolio = {
    account: address,
    nativeBalance: result.nativeBalance,
    assetBalances,
    lastUpdated: result.lastUpdated,
  };

  if (deps.priceProvider) {
    try {
      let totalUsd = 0;
      let hasPrice = false;
      for (const balance of assetBalances) {
        const price = await deps.priceProvider(balance.asset.code, balance.asset.issuer);
        if (price === null || price === undefined) continue;
        hasPrice = true;
        const units = Number(balance.balance) / 1e7;
        totalUsd += price * units;
      }
      if (hasPrice) {
        portfolio.totalValueUSD = totalUsd.toFixed(2);
      }
    } catch (err) {
      log.warn("Price lookup failed for portfolio", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await writeCache(address, portfolio, config.portfolioCacheSeconds);
  return portfolio;
}

/** Break the portfolio cache (used after writes / in tests). */
export async function invalidatePortfolioCache(address: string): Promise<void> {
  try {
    const redis = getRedisConnection();
    await redis.del(`assets:portfolio:${address}`);
  } catch {
    memoryCache.delete(address);
  }
  memoryCache.delete(address);
}

/** Small helper used by tests to seed the cache without Redis. */
export function seedPortfolioCacheForTesting(address: string, portfolio: Portfolio): void {
  memoryCache.set(address, { value: portfolio, expiresAt: Date.now() + 300_000 });
}

/** Re-exported for callers that assemble balances directly. */
export function referenceFromHorizonBalance(b: HorizonBalance) {
  return horizonBalanceToReference(b);
}