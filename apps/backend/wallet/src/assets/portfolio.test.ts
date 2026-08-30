/**
 * Portfolio assembly + caching tests — Issue #108.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Portfolio } from "@delegolabs/types";
import {
  getPortfolio,
  classifySpam,
  invalidatePortfolioCache,
  seedPortfolioCacheForTesting,
} from "./portfolio.js";
import { createSpamFilter } from "./spamFilter.js";

const ORIGINAL_ENV = { ...process.env };
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeServer(balances: unknown[]) {
  return {
    loadAccount: async () => ({ balances }),
    assets: () => ({
      forCode: () => ({
        forIssuer: () => ({
          limit: () => ({ call: async () => ({ records: [] }) }),
        }),
      }),
    }),
    accounts: () => ({
      accountId: () => ({ call: async () => ({ home_domain: null }) }),
    }),
  };
}

const CACHED: Portfolio = {
  account: ADDRESS,
  nativeBalance: "5000000",
  assetBalances: [
    {
      asset: { code: "XLM", issuer: "", type: "native" },
      balance: "5000000",
      available: "5000000",
      locked: "0",
      lastUpdated: new Date().toISOString(),
    },
  ],
  lastUpdated: new Date().toISOString(),
};

describe("getPortfolio", () => {
  it("returns the cached portfolio without touching the network", async () => {
    seedPortfolioCacheForTesting(ADDRESS, CACHED);
    const loadAccount = () => {
      throw new Error("should not hit network");
    };
    const result = await getPortfolio(ADDRESS, {
      server: { loadAccount } as never,
    });
    expect(result).toEqual(CACHED);

    await invalidatePortfolioCache(ADDRESS);
    await expect(
      getPortfolio(ADDRESS, {
        server: { loadAccount } as never,
        discovery: { server: makeServer([]) as never },
      }),
    ).rejects.toThrow("should not hit network");
  });

  it("builds a fresh portfolio from horizon balances, filtering spam when enabled", async () => {
    process.env.ASSET_SPAM_FILTER_UNLISTED = "true";
    process.env.ASSET_SPAM_FILTER_ENABLED = "true";
    delete process.env.ASSET_SPAM_ALLOWLIST;
    delete process.env.ASSET_SPAM_BLOCKLIST;

    const addr = `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${"WHJ"}`;
    const server = makeServer([
      { asset_type: "native", balance: "3.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "2.0000000",
      },
    ]);

    const result = await getPortfolio(addr, {
      server: server as never,
      discovery: { server: server as never },
      priceProvider: async () => 1.0,
    });

    expect(result.account).toBe(addr);
    expect(result.nativeBalance).toBe("30000000");
    // USDC is unlisted (no home domain) and filtered out.
    expect(result.assetBalances).toHaveLength(1);
    expect(result.assetBalances[0].asset.code).toBe("XLM");
  });

  it("enriches with totalValueUSD when a price provider is configured", async () => {
    delete process.env.ASSET_SPAM_FILTER_UNLISTED;
    const addr = `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${"WHK"}`;
    const server = makeServer([
      { asset_type: "native", balance: "2.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "4.0000000",
      },
    ]);

    const result = await getPortfolio(addr, {
      server: server as never,
      discovery: { server: server as never },
      priceProvider: async (code) => (code === "XLM" ? 0.5 : 1.0),
    });

    expect(result.assetBalances).toHaveLength(2);
    expect(result.totalValueUSD).toBe("5.00");
  });
});

describe("classifySpam", () => {
  it("returns allowed verdicts for native and pool entries", async () => {
    const verdicts = await classifySpam(
      [
        {
          asset: { code: "XLM", issuer: "", type: "native" },
          balance: "1",
          available: "1",
          locked: "0",
          lastUpdated: new Date().toISOString(),
        },
        {
          asset: { code: "LP", issuer: "POOL", type: "liquidity_pool" },
          balance: "1",
          available: "1",
          locked: "0",
          lastUpdated: new Date().toISOString(),
        },
      ],
      { discovery: { server: makeServer([]) as never } },
    );
    expect(verdicts.XLM?.isSpam).toBe(false);
    expect(verdicts["LP:POOL"]?.isSpam).toBe(false);
  });

  it("marks unknown credit assets via the active filter", async () => {
    process.env.ASSET_SPAM_FILTER_UNLISTED = "true";
    const server = makeServer([]);
    const verdicts = await classifySpam(
      [
        {
          asset: { code: "SCAM", issuer: ISSUER, type: "credit_alphanum4" },
          balance: "1",
          available: "1",
          locked: "0",
          lastUpdated: new Date().toISOString(),
        },
      ],
      { discovery: { server: server as never } },
    );
    expect(verdicts[`SCAM:${ISSUER}`]?.isSpam).toBe(true);
    expect(verdicts[`SCAM:${ISSUER}`]?.reason).toContain("SEP-1");
  });
});

describe("createSpamFilter integration", () => {
  it("reads environment-driven settings", () => {
    process.env.ASSET_SPAM_BLOCKLIST = "SCAM:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const filter = createSpamFilter();
    expect(filter.settings.blocklist.map((k) => k.toUpperCase())).toContain(
      "SCAM:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
  });
});