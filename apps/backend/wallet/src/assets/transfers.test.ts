/**
 * Asset transfer helper tests — Issue #108.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { TransactionRequest } from "@delegolabs/types";
import { createTransferService } from "./transfers.js";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ADDRESS = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const usdc = { code: "USDC", issuer: ISSUER, type: "credit_alphanum4" } as const;

function result(hash = "deadbeef") {
  return { hash, success: true, ledger: 12345 };
}

function opType(op: unknown): string {
  return (op as { body: () => { switch: () => { name: string } } }).body()
    .switch()
    .name;
}

describe("createTransferService.send", () => {
  it("throws when required fields are missing", async () => {
    const service = createTransferService();
    await expect(service.send({} as never)).rejects.toThrow("sourceAddress");
  });

  it("rejects liquidity-pool-share transfers", async () => {
    const service = createTransferService();
    await expect(
      service.send({
        sourceAddress: ADDRESS,
        destination: DEST,
        asset: { code: "LP", issuer: "POOL1", type: "liquidity_pool" },
        amountStroops: "100",
      }),
    ).rejects.toThrow(/liquidity/i);
  });

  it("sends a classic payment with the injected submitter", async () => {
    const submit = vi.fn().mockResolvedValue(result());
    const service = createTransferService({
      submitter: { submit },
    });
    const out = await service.send({
      sourceAddress: ADDRESS,
      destination: DEST,
      asset: usdc,
      amountStroops: "10000000",
      memo: "buy",
    });
    expect(out.hash).toBe("deadbeef");
    expect(out.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    const call = submit.mock.calls[0][0];
    expect(call.sourceAddress).toBe(ADDRESS);
    expect(call.memo).toBe("buy");
    expect(call.operations).toHaveLength(1);
  });

  it("routes SAC transfers through the Soroban queue path", async () => {
    const submitSoroban = vi.fn().mockResolvedValue(result("sac-hash"));
    const service = createTransferService({
      submitSoroban,
      submitter: { submit: vi.fn().mockResolvedValue(result("classic-hash")) },
    });
    const out = await service.send({
      sourceAddress: ADDRESS,
      destination: DEST,
      asset: usdc,
      amountStroops: "500000",
      contractId: "CCONTRACTID0000000000000000000000000000000000000000000000000000000",
    });
    expect(out.hash).toBe("sac-hash");
    const req: TransactionRequest = submitSoroban.mock.calls[0][0];
    expect(req.method).toBe("transfer");
    expect(req.contractId).toContain("CCONTRACTID");
    expect(req.argTypes).toEqual(["address", "address", "i128"]);
    expect(req.args).toEqual([ADDRESS, DEST, "500000"]);
  });

  it("falls back to classic payment when contractId is omitted", async () => {
    const classic = vi.fn().mockResolvedValue(result("classic-hash"));
    const service = createTransferService({
      submitter: { submit: classic },
    });
    const out = await service.send({
      sourceAddress: ADDRESS,
      destination: DEST,
      asset: usdc,
      amountStroops: "1",
    });
    expect(out.hash).toBe("classic-hash");
    expect(classic).toHaveBeenCalledTimes(1);
  });
});

describe("createTransferService.pathPayment", () => {
  it("submits a strict-send path payment", async () => {
    const submit = vi.fn().mockResolvedValue(result("pp"));
    const service = createTransferService({ submitter: { submit } });
    const out = await service.pathPayment({
      sourceAddress: ADDRESS,
      destination: DEST,
      sendAsset: usdc,
      sendAmountStroops: "1000",
      destAsset: { code: "XLM", issuer: "", type: "native" },
      destMinAmountStroops: "900",
      path: [{ code: "XLM", issuer: "", type: "native" }],
    });
    expect(out.success).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].operations).toHaveLength(1);
  });

  it("rejects path payments using liquidity pool shares", async () => {
    const service = createTransferService();
    await expect(
      service.pathPayment({
        sourceAddress: ADDRESS,
        destination: DEST,
        sendAsset: { code: "LP", issuer: "POOL", type: "liquidity_pool" },
        sendAmountStroops: "1",
        destAsset: { code: "XLM", issuer: "", type: "native" },
        destMinAmountStroops: "1",
      }),
    ).rejects.toThrow(/liquidity/i);
  });
});

describe("createTransferService liquidity pool helpers", () => {
  it("builds a liquidityPoolDeposit operation", async () => {
    const submit = vi.fn().mockResolvedValue(result("dep"));
    const service = createTransferService({ submitter: { submit } });
    const out = await service.liquidityPoolDeposit({
      sourceAddress: ADDRESS,
      poolId: "abc123",
      maxAmountA: "10000000",
      maxAmountB: "20000000",
      minPrice: "0.5",
      maxPrice: "2.0",
      memo: "deposit",
    });
    expect(out.hash).toBe("dep");
    expect(opType(submit.mock.calls[0][0].operations[0])).toBe("liquidityPoolDeposit");
  });

  it("builds a liquidityPoolWithdraw operation", async () => {
    const submit = vi.fn().mockResolvedValue(result("wd"));
    const service = createTransferService({ submitter: { submit } });
    const out = await service.liquidityPoolWithdraw({
      sourceAddress: ADDRESS,
      poolId: "abc123",
      amountStroops: "10000000",
      minAmountA: "1000",
      minAmountB: "2000",
    });
    expect(out.hash).toBe("wd");
    expect(opType(submit.mock.calls[0][0].operations[0])).toBe("liquidityPoolWithdraw");
  });
});