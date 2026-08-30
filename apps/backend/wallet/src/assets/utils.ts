/**
 * Asset helpers — Issue #108.
 * Canonical asset keys, stroops <-> decimal conversions, and asset type
 * normalization used across the asset management module.
 */
import { Asset } from "@stellar/stellar-sdk";
import type { AssetReference, AssetType } from "@delegolabs/types";

export const NATIVE_CODE = "XLM";

/**
 * Convert a fixed-precision decimal string (e.g. Horizon's "12.3456789")
 * into integer stroops. Trailing decimals beyond 7 digits are ignored.
 */
export function toStroops(value: string, decimals = 7): string {
  const parts = value.split(".");
  const whole = parts[0];
  let fraction = parts[1] || "";
  fraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = whole + fraction;
  const trimmed = combined.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

/** Convert integer stroops into a fixed-precision decimal string. */
export function fromStroops(stroops: string, decimals = 7): string {
  const value = BigInt(stroops.length === 0 ? "0" : stroops);
  const isNegative = value < 0n;
  const absolute = isNegative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  const result = `${whole.toString()}.${fraction}`;
  return isNegative ? `-${result}` : result;
}

export function isNativeCode(code: string): boolean {
  return code === "" || code === "XLM" || code === "native";
}

export function nativeAssetReference(): AssetReference {
  return { code: NATIVE_CODE, issuer: "", type: "native" };
}

/**
 * Deterministic canonical key for an asset: "XLM" for native,
 * "CODE:ISSUER" for credit assets, "LP:POOLID" for liquidity pool shares.
 * Used for maps, Redis cache keys, and spam allow/blocklists.
 */
export function assetKey(asset: Pick<AssetReference, "code" | "issuer" | "type">): string {
  if (asset.type === "native" || isNativeCode(asset.code)) {
    return NATIVE_CODE;
  }
  if (asset.type === "liquidity_pool") {
    return `LP:${asset.issuer}`;
  }
  return `${asset.code}:${asset.issuer}`;
}

/** Parse a canonical "CODE:ISSUER" / "XLM" / "LP:POOLID" key back into a reference. */
export function parseAssetKey(key: string): AssetReference | null {
  const trimmed = key.trim();
  if (trimmed === "") return null;
  if (isNativeCode(trimmed)) return nativeAssetReference();
  if (trimmed.startsWith("LP:") && trimmed.length > 3) {
    return { code: "LP", issuer: trimmed.slice(3), type: "liquidity_pool" };
  }
  const idx = trimmed.indexOf(":");
  if (idx <= 0) return null;
  const code = trimmed.slice(0, idx);
  const issuer = trimmed.slice(idx + 1);
  if (!code || !issuer) return null;
  return { code, issuer, type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12" };
}

/** Horizon balance object. */
export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  clawback_enabled?: boolean;
  buying_liabilities?: string;
  selling_liabilities?: string;
  liquidity_pool_id?: string;
}

/** Convert a Horizon balance object into an AssetReference. */
export function horizonBalanceToReference(balance: HorizonBalance): AssetReference {
  switch (balance.asset_type) {
    case "native":
      return nativeAssetReference();
    case "liquidity_pool_shares":
      return {
        code: "LP",
        issuer: balance.liquidity_pool_id ?? "",
        type: "liquidity_pool",
      };
    default: {
      const code = balance.asset_code ?? "UNKNOWN";
      const issuer = balance.asset_issuer ?? "";
      return {
        code,
        issuer,
        type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      };
    }
  }
}

/** Map an AssetReference to the SDK's Asset class (throws for liquidity pool). */
export function toSdkAsset(ref: AssetReference): Asset {
  if (ref.type === "native" || isNativeCode(ref.code)) return Asset.native();
  return new Asset(ref.code, ref.issuer);
}

/** Map an SDK Asset to an AssetReference. */
export function sdkAssetToReference(asset: Asset): AssetReference {
  if (asset.isNative()) return nativeAssetReference();
  const code = asset.getCode();
  return {
    code,
    issuer: asset.getIssuer() ?? "",
    type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
  };
}

export function toAssetType(sdkType: string): AssetType {
  switch (sdkType) {
    case "native":
      return "native";
    case "credit_alphanum4":
      return "credit_alphanum4";
    case "credit_alphanum12":
      return "credit_alphanum12";
    case "liquidity_pool":
    case "liquidity_pool_shares":
      return "liquidity_pool";
    default:
      return "credit_alphanum12";
  }
}