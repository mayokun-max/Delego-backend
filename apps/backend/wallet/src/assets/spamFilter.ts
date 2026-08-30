/**
 * Spam asset filtering — Issue #108.
 *
 * Stellar accounts can hold trustlines to unverified or fraudulent assets.
 * This module provides configurable filtering so wallets can hide or mark
 * suspicious holdings. Configuration lives in the environment
 * (ASSET_SPAM_*) and is read once per call via `readAssetServiceConfig`,
 * which keeps rule evaluation synchronous, pure, and easy to unit test.
 */
import type { AssetReference, SpamFilterSettings } from "@delegolabs/types";
import { assetKey, isNativeCode } from "./utils.js";

export type SpamVerdict = "allowed" | "blocklisted" | "unlisted" | "unknown";

export interface SpamFilterResult {
  isSpam: boolean;
  verdict: SpamVerdict;
  reason: string | null;
}

export interface SpamFilterInput {
  /**
   * True when the asset publishes SEP-1 metadata (has a real issuer
   * home domain entry) or is otherwise a known/verified asset.
   */
  hasMetadata: boolean;
  /** Total trustline population on the network (0 = unknown). */
  trustlineCount?: number;
}

export interface SpamFilter {
  /** Static snapshot of the active settings. */
  settings: SpamFilterSettings;
  /** Evaluate a single asset. */
  evaluate(asset: AssetReference, input: SpamFilterInput): SpamFilterResult;
  /** Convenience: boolean whether an asset should be hidden. */
  isSpam(asset: AssetReference, input: SpamFilterInput): boolean;
}

/**
 * Build the filter from explicit settings (tests) or the environment
 * (production). `settings` wins when provided.
 */
export function createSpamFilter(settings?: Partial<SpamFilterSettings>): SpamFilter {
  const env = readEnvSettings();
  const merged: SpamFilterSettings = {
    enabled: settings?.enabled ?? env.enabled,
    filterUnlisted: settings?.filterUnlisted ?? env.filterUnlisted,
    allowlist: settings?.allowlist ?? env.allowlist,
    blocklist: settings?.blocklist ?? env.blocklist,
  };

  const blocklist = new Set(merged.blocklist.map(normalizeKey));
  const allowlist = new Set(merged.allowlist.map(normalizeKey));

  return {
    settings: merged,
    evaluate(asset, input) {
      if (!merged.enabled) {
        return { isSpam: false, verdict: "allowed", reason: null };
      }

      const key = assetKey(asset);
      const normalizedKey = normalizeKey(key);

      if (isNativeCode(asset.code) || allowlist.has(normalizedKey)) {
        return { isSpam: false, verdict: "allowed", reason: null };
      }
      if (blocklist.has(normalizedKey)) {
        return {
          isSpam: true,
          verdict: "blocklisted",
          reason: `Asset ${key} is on the blocklist`,
        };
      }
      if (merged.filterUnlisted && !input.hasMetadata) {
        return {
          isSpam: true,
          verdict: "unlisted",
          reason: `Asset ${key} has no published SEP-1 metadata`,
        };
      }
      return { isSpam: false, verdict: "unknown", reason: null };
    },
    isSpam(asset, input) {
      return this.evaluate(asset, input).isSpam;
    },
  };
}

function normalizeKey(key: string): string {
  return key.trim().toUpperCase();
}

function readEnvSettings(): SpamFilterSettings {
  const toList = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    enabled: process.env.ASSET_SPAM_FILTER_ENABLED !== "false",
    filterUnlisted: process.env.ASSET_SPAM_FILTER_UNLISTED === "true",
    allowlist: toList(process.env.ASSET_SPAM_ALLOWLIST),
    blocklist: toList(process.env.ASSET_SPAM_BLOCKLIST),
  };
}