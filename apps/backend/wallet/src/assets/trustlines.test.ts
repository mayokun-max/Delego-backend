/**
 * Trustline management tests — Issue #108.
 */
import { describe, expect, it, vi } from "vitest";
import { createTrustlineService } from "./trustlines.js";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const usdc = { code: "USDC", issuer: ISSUER, type: "credit_alphanum4" } as const;

function result(hash = "hash1") {
  return { hash, success: true, ledger: 99 };
}

function opType(op: unknown): string {
  return (op as { body: () => { switch: () => { name: string } } }).body()
    .switch()
    .name;
}

function changeTrustLimit(op: unknown): string {
  return (op as { body: () => { changeTrustOp: () => { limit: () => { toBigInt: () => bigint } } } })
    .body()
    .changeTrustOp()
    .limit()
    .toBigInt()
    .toString();
}

describe("createTrustlineService", () => {
  it("creates a trustline via ChangeTrust with the request limit", async () => {
    const submit = vi.fn().mockResolvedValue(result());
    const service = createTrustlineService({ submitter: { submit } });
    const out = await service.createOrUpdate({
      account: ADDRESS,
      asset: usdc,
      limit: "10000000",
    });
    expect(out.success).toBe(true);
    expect(opType(submit.mock.calls[0][0].operations[0])).toBe("changeTrust");
    expect(submit.mock.calls[0][0].sourceAddress).toBe(ADDRESS);
    expect(changeTrustLimit(submit.mock.calls[0][0].operations[0])).toBe("10000000");
  });

  it("uses the max canonical limit when no limit is supplied", async () => {
    const submit = vi.fn().mockResolvedValue(result());
    const service = createTrustlineService({ submitter: { submit } });
    await service.createOrUpdate({ account: ADDRESS, asset: usdc });
    expect(changeTrustLimit(submit.mock.calls[0][0].operations[0])).toBe(
      "9223372036854775807",
    );
  });

  it("rejects a zero limit on create", async () => {
    const service = createTrustlineService();
    await expect(
      service.createOrUpdate({ account: ADDRESS, asset: usdc, limit: "0" }),
    ).rejects.toThrow("DELETE");
  });

  it("deletes a trustline by setting the limit to zero", async () => {
    const submit = vi.fn().mockResolvedValue(result("del"));
    const service = createTrustlineService({ submitter: { submit } });
    const out = await service.delete({ account: ADDRESS, asset: usdc });
    expect(out.hash).toBe("del");
    expect(changeTrustLimit(submit.mock.calls[0][0].operations[0])).toBe("0");
  });

  it("authorizes a trustline with the issuer as the source", async () => {
    const submit = vi.fn().mockResolvedValue(result("auth"));
    const service = createTrustlineService({ submitter: { submit } });
    const out = await service.authorize({
      account: ADDRESS,
      asset: usdc,
      authorized: true,
    });
    expect(out.hash).toBe("auth");
    expect(opType(submit.mock.calls[0][0].operations[0])).toBe("setTrustLineFlags");
    expect(submit.mock.calls[0][0].sourceAddress).toBe(ISSUER);
  });

  it("rejects non-credit assets for trustlines", async () => {
    const service = createTrustlineService();
    await expect(
      service.createOrUpdate({
        account: ADDRESS,
        asset: { code: "LP", issuer: "POOL", type: "liquidity_pool" },
      }),
    ).rejects.toThrow("cannot hold");
    await expect(
      service.createOrUpdate({
        account: ADDRESS,
        asset: { code: "XLM", issuer: "", type: "native" },
      }),
    ).rejects.toThrow("cannot hold");
  });

  it("rejects missing account or asset details", async () => {
    const service = createTrustlineService();
    await expect(
      service.createOrUpdate({ account: "", asset: usdc }),
    ).rejects.toThrow("required");
    await expect(
      service.createOrUpdate({ account: ADDRESS, asset: undefined as never }),
    ).rejects.toThrow("required");
  });
});