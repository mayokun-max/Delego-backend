/**
 * Asset helper unit tests — Issue #108.
 */
import { describe, expect, it } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import {
  NATIVE_CODE,
  toStroops,
  fromStroops,
  isNativeCode,
  nativeAssetReference,
  assetKey,
  parseAssetKey,
  horizonBalanceToReference,
  toSdkAsset,
  sdkAssetToReference,
  toAssetType,
} from "./utils.js";

const ISSUER_A = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("toStroops / fromStroops", () => {
  it("converts decimal strings to integer stroops", () => {
    expect(toStroops("1.0000000")).toBe("10000000");
    expect(toStroops("0.5")).toBe("5000000");
    expect(toStroops("12.3456789")).toBe("123456789");
  });

  it("pads short fractions and slices excess precision", () => {
    expect(toStroops("1.5")).toBe("15000000");
    expect(toStroops("1.12345678901")).toBe("11234567");
    expect(toStroops("100")).toBe("1000000000");
  });

  it("handles zero and empty", () => {
    expect(toStroops("0")).toBe("0");
    expect(toStroops("")).toBe("0");
  });

  it("round-trips stroops -> decimal -> stroops", () => {
    expect(fromStroops("123456789")).toBe("12.3456789");
    expect(toStroops(fromStroops("123456789"))).toBe("123456789");
    expect(fromStroops("7")).toBe("0.0000007");
  });
});

describe("isNativeCode / nativeAssetReference", () => {
  it.each(["XLM", "", "native"])("treats %j as native", (code) => {
    expect(isNativeCode(code)).toBe(true);
    expect(assetKey({ code, issuer: "GABC", type: "native" })).toBe(NATIVE_CODE);
  });

  it("builds the canonical native reference", () => {
    expect(nativeAssetReference()).toEqual({ code: "XLM", issuer: "", type: "native" });
  });
});

describe("assetKey / parseAssetKey", () => {
  const ref = { code: "USDC", issuer: ISSUER_A, type: "credit_alphanum4" } as const;

  it("produces canonical keys", () => {
    expect(assetKey(ref)).toBe(`USDC:${ISSUER_A}`);
    expect(assetKey({ code: "XLM", issuer: "", type: "native" })).toBe("XLM");
    expect(
      assetKey({ code: "LP", issuer: "POOLID1234", type: "liquidity_pool" }),
    ).toBe("LP:POOLID1234");
  });

  it("round-trips keys through parseAssetKey", () => {
    expect(parseAssetKey(`USDC:${ISSUER_A}`)).toEqual(ref);
    expect(parseAssetKey("XLM")?.type).toBe("native");
    expect(parseAssetKey("LP:POOLID1234")?.type).toBe("liquidity_pool");
    expect(parseAssetKey("LONGCOINTEST:ISSUER")?.type).toBe("credit_alphanum12");
  });

  it("rejects malformed keys", () => {
    expect(parseAssetKey(":ISSUER")).toBeNull();
    expect(parseAssetKey("CODE:")).toBeNull();
    expect(parseAssetKey("")).toBeNull();
    expect(parseAssetKey("LP:")).toBeNull();
  });
});

describe("horizonBalanceToReference", () => {
  it("maps native balances", () => {
    expect(horizonBalanceToReference({ asset_type: "native", balance: "10" })).toEqual(
      nativeAssetReference(),
    );
  });

  it("maps liquidity pool shares", () => {
    const ref = horizonBalanceToReference({
      asset_type: "liquidity_pool_shares",
      balance: "1",
      liquidity_pool_id: "POOL1",
    });
    expect(ref.type).toBe("liquidity_pool");
    expect(ref.issuer).toBe("POOL1");
  });

  it("maps credit assets with correct type by code length", () => {
    expect(
      horizonBalanceToReference({
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER_A,
        balance: "1",
      }),
    ).toEqual({ code: "USDC", issuer: ISSUER_A, type: "credit_alphanum4" });

    const twelve = horizonBalanceToReference({
      asset_type: "credit_alphanum12",
      asset_code: "VERYLONGCODE",
      asset_issuer: ISSUER_A,
      balance: "1",
    });
    expect(twelve.type).toBe("credit_alphanum12");
  });
});

describe("toSdkAsset / sdkAssetToReference", () => {
  it("maps native references to the native asset", () => {
    expect(toSdkAsset(nativeAssetReference()).isNative()).toBe(true);
  });

  it("maps credit references to SDK assets and back", () => {
    const ref = { code: "USDC", issuer: ISSUER_A, type: "credit_alphanum4" } as const;
    const sdk = toSdkAsset(ref);
    expect(sdk.getCode()).toBe("USDC");
    expect(sdk.getIssuer()).toBe(ISSUER_A);
  });

  it("round-trips SDK credit assets", () => {
    const sdk = new Asset("USD", ISSUER_A);
    expect(sdkAssetToReference(sdk)).toEqual({
      code: "USD",
      issuer: ISSUER_A,
      type: "credit_alphanum4",
    });
  });
});

describe("toAssetType", () => {
  it("normalizes Horizon asset types", () => {
    expect(toAssetType("native")).toBe("native");
    expect(toAssetType("credit_alphanum4")).toBe("credit_alphanum4");
    expect(toAssetType("credit_alphanum12")).toBe("credit_alphanum12");
    expect(toAssetType("liquidity_pool")).toBe("liquidity_pool");
    expect(toAssetType("liquidity_pool_shares")).toBe("liquidity_pool");
  });
});