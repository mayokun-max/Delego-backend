/**
 * Asset service config tests — Issue #108.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { getStellarConfig, readAssetServiceConfig } from "./config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getStellarConfig", () => {
  it("defaults to testnet settings", () => {
    delete process.env.STELLAR_NETWORK;
    const config = getStellarConfig();
    expect(config.network).toBe("testnet");
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(config.horizonUrl).toContain("horizon-testnet");
  });

  it("resolves mainnet endpoints and passphrase", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    const config = getStellarConfig();
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
    expect(config.horizonUrl).toBe("https://horizon.stellar.org");
    expect(config.rpcUrl).toBe("https://rpc.stellar.org");
  });

  it("honors explicit endpoint overrides", () => {
    process.env.STELLAR_NETWORK = "futurenet";
    process.env.STELLAR_HORIZON_URL = "https://custom-horizon.example.com";
    const config = getStellarConfig();
    expect(config.horizonUrl).toBe("https://custom-horizon.example.com");
  });
});

describe("readAssetServiceConfig", () => {
  it("applies defaults when env vars are absent", () => {
    delete process.env.ASSET_METADATA_CACHE_TTL_SECONDS;
    delete process.env.ASSET_BALANCE_POLL_INTERVAL_SECONDS;
    delete process.env.ASSET_PORTFOLIO_CACHE_SECONDS;
    delete process.env.ASSET_SPAM_FILTER_ENABLED;
    delete process.env.ASSET_SPAM_FILTER_UNLISTED;
    delete process.env.ASSET_MAX_BALANCES;
    const config = readAssetServiceConfig();
    expect(config.metadataCacheTtlSeconds).toBe(3600);
    expect(config.balancePollIntervalSeconds).toBe(30);
    expect(config.portfolioCacheSeconds).toBe(5);
    expect(config.spamFilterEnabled).toBe(true);
    expect(config.spamFilterUnlisted).toBe(false);
    expect(config.maxBalances).toBe(500);
    expect(config.spamAllowlist).toEqual([]);
  });

  it("parses env values and comma-separated lists", () => {
    process.env.ASSET_METADATA_CACHE_TTL_SECONDS = "120";
    process.env.ASSET_BALANCE_POLL_INTERVAL_SECONDS = "10";
    process.env.ASSET_PORTFOLIO_CACHE_SECONDS = "2";
    process.env.ASSET_SPAM_FILTER_ENABLED = "false";
    process.env.ASSET_SPAM_FILTER_UNLISTED = "true";
    process.env.ASSET_MAX_BALANCES = "25";
    process.env.ASSET_SPAM_ALLOWLIST = "XLM, USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    process.env.ASSET_SPAM_BLOCKLIST = "SCAM:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    const config = readAssetServiceConfig();
    expect(config.metadataCacheTtlSeconds).toBe(120);
    expect(config.balancePollIntervalSeconds).toBe(10);
    expect(config.portfolioCacheSeconds).toBe(2);
    expect(config.spamFilterEnabled).toBe(false);
    expect(config.spamFilterUnlisted).toBe(true);
    expect(config.maxBalances).toBe(25);
    expect(config.spamAllowlist).toHaveLength(2);
    expect(config.spamAllowlist[1]).toBe("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    expect(config.spamBlocklist).toHaveLength(1);
  });
});