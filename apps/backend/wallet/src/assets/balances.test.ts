/**
 * Balance loading + real-time tracker tests — Issue #108.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccountBalances, BalanceTracker } from "./balances.js";

vi.mock("../websocket/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../websocket/server.js")>();
  return {
    ...actual,
    broadcastBalanceEvent: vi.fn(),
    getSubscriberCount: vi.fn(() => 1),
  };
});

import { broadcastBalanceEvent, getSubscriberCount } from "../websocket/server.js";

const mute = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

interface FakeServer {
  loadAccount: ReturnType<typeof vi.fn>;
  assets: () => unknown;
  accounts: () => unknown;
}

function makeServer(balances: unknown[]): FakeServer {
  return {
    loadAccount: vi.fn(async () => ({ balances })),
    assets: () => ({
      forCode: () => ({
        forIssuer: () => ({
          limit: () => ({
            call: async () => ({ records: [{ flags: { auth_required: true } }] }),
          }),
        }),
      }),
    }),
    accounts: () => ({
      accountId: () => ({
        call: async () => ({ home_domain: null }),
      }),
    }),
  };
}

afterEach(() => {
  (broadcastBalanceEvent as ReturnType<typeof vi.fn>).mockClear();
  (getSubscriberCount as ReturnType<typeof vi.fn>).mockClear();
});

describe("getAccountBalances", () => {
  it("maps native, credit, liquidity-pool and trustline balances", async () => {
    const server = makeServer([
      { asset_type: "native", asset_code: "XLM", balance: "50.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "25.0000000",
        limit: "100.0000000",
        is_authorized: true,
      },
      {
        asset_type: "liquidity_pool_shares",
        balance: "5.0000000",
        buying_liabilities: "2.0000000",
        liquidity_pool_id: "POOL001",
      },
    ]);

    const result = await getAccountBalances(ADDRESS, {
      server: server as never,
      discovery: { server: server as never },
    });

    expect(result.address).toBe(ADDRESS);
    expect(result.nativeBalance).toBe("500000000");
    expect(result.balances[0].asset.type).toBe("native");
    expect(result.balances[0].balance).toBe("500000000");

    const usdc = result.balances.find((b) => b.asset.code === "USDC");
    expect(usdc).toBeDefined();
    expect(usdc?.balance).toBe("250000000");
    expect(usdc?.trustline?.authorized).toBe(true);
    expect(usdc?.trustline?.limit).toBe("1000000000");

    const lp = result.balances.find((b) => b.asset.type === "liquidity_pool");
    expect(lp?.asset.issuer).toBe("POOL001");
    expect(lp?.locked).toBe("20000000");
    expect(lp?.available).toBe("30000000");

    expect(result.trustlines).toHaveLength(1);
    expect(result.trustlines[0].asset.code).toBe("USDC");
  });

  it("handles an account with no balances", async () => {
    const server = makeServer([]);
    const result = await getAccountBalances(ADDRESS, {
      server: server as never,
      discovery: { server: server as never },
    });
    expect(result.nativeBalance).toBe("0");
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0].asset.type).toBe("native");
    expect(result.trustlines).toHaveLength(0);
  });

  it("computes available balance after liabilities", async () => {
    const server = makeServer([
      {
        asset_type: "credit_alphanum4",
        asset_code: "BTC",
        asset_issuer: ISSUER,
        balance: "10.0000000",
        selling_liabilities: "3.0000000",
      },
    ]);
    const result = await getAccountBalances(ADDRESS, {
      server: server as never,
      discovery: { server: server as never },
    });
    const btc = result.balances.find((b) => b.asset.code === "BTC");
    expect(btc?.balance).toBe("100000000");
    expect(btc?.available).toBe("70000000");
    expect(btc?.locked).toBe("30000000");
  });
});

describe("BalanceTracker.pollOnce", () => {
  beforeEach(() => {
    mute(getSubscriberCount).mockReturnValue(1);
  });

  it("broadcasts all assets on the first poll", async () => {
    const server = makeServer([
      { asset_type: "native", balance: "10.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "1.0000000",
      },
    ]);
    const tracker = new BalanceTracker({
      server: server,
      discovery: { server: server },
    } as never);

    const addr = `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${"WHF"}`;
    const changed = await tracker.pollOnce(addr);
    expect(changed).toContain("XLM");
    expect(changed).toContain(`USDC:${ISSUER}`);
    expect(broadcastBalanceEvent).toHaveBeenCalledTimes(1);
    const event = (broadcastBalanceEvent as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(event.type).toBe("balances_updated");
    expect(event.changedAssets).toEqual(changed);
  });

  it("broadcasts only changed assets on subsequent polls", async () => {
    const balances = [
      { asset_type: "native", balance: "10.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "1.0000000",
      },
    ];
    const server = makeServer(balances);
    const tracker = new BalanceTracker({
      server: server,
      discovery: { server: server },
    } as never);

    const addr = `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${"WHE"}`;
    await tracker.pollOnce(addr);
    (broadcastBalanceEvent as ReturnType<typeof vi.fn>).mockClear();

    balances[0].balance = "11.0000000";
    const changed = await tracker.pollOnce(addr);
    expect(changed).toEqual(["XLM"]);
    expect(broadcastBalanceEvent).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast when nothing changed", async () => {
    const server = makeServer([{ asset_type: "native", balance: "5.0000000" }]);
    const tracker = new BalanceTracker({ server: server } as never);
    const addr = `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${"WHG"}`;
    await tracker.pollOnce(addr);
    (broadcastBalanceEvent as ReturnType<typeof vi.fn>).mockClear();
    const changed = await tracker.pollOnce(addr);
    expect(changed).toEqual([]);
    expect(broadcastBalanceEvent).not.toHaveBeenCalled();
  });

  it("start/stop lifecycle manages timers", () => {
    const server = makeServer([]);
    const tracker = new BalanceTracker({
      server: server,
      discovery: { server: server },
    } as never);
    const addr = `GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${"WHH"}`;
    tracker.start(addr);
    tracker.start(addr);
    expect(tracker.activeAddresses).toContain(addr);
    tracker.stop(addr);
    expect(tracker.activeAddresses).not.toContain(addr);
  });
});