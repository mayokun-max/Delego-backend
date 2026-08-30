/**
 * Spam filter unit tests — Issue #108.
 */
import { describe, expect, it } from "vitest";
import { createSpamFilter } from "./spamFilter.js";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const usdc = { code: "USDC", issuer: ISSUER, type: "credit_alphanum4" } as const;
const unknown = { code: "SOME", issuer: ISSUER, type: "credit_alphanum4" } as const;
const native = { code: "XLM", issuer: "", type: "native" } as const;

describe("createSpamFilter", () => {
  it("allows everything when disabled", () => {
    const filter = createSpamFilter({ enabled: false, filterUnlisted: true });
    const result = filter.evaluate(unknown, { hasMetadata: false, trustlineCount: 0 });
    expect(result).toEqual({ isSpam: false, verdict: "allowed", reason: null });
    expect(filter.isSpam(unknown, { hasMetadata: false })).toBe(false);
  });

  it("whitelists native assets regardless of settings", () => {
    const filter = createSpamFilter({ enabled: true, filterUnlisted: true });
    expect(filter.evaluate(native, { hasMetadata: false }).isSpam).toBe(false);
    expect(filter.evaluate(native, { hasMetadata: false }).verdict).toBe("allowed");
  });

  it("respects the allowlist", () => {
    const filter = createSpamFilter({
      enabled: true,
      filterUnlisted: true,
      allowlist: ["XLM", `USDC:${ISSUER}`],
    });
    expect(filter.evaluate(usdc, { hasMetadata: false }).isSpam).toBe(false);
    expect(filter.evaluate(usdc, { hasMetadata: false }).verdict).toBe("allowed");
  });

  it("flags blocklisted assets even when they publish metadata", () => {
    const filter = createSpamFilter({
      enabled: true,
      filterUnlisted: true,
      blocklist: [`SOME:${ISSUER}`],
    });
    const result = filter.evaluate(unknown, { hasMetadata: true });
    expect(result.isSpam).toBe(true);
    expect(result.verdict).toBe("blocklisted");
    expect(result.reason).toContain("blocklist");
  });

  it("flags unlisted assets when filterUnlisted is on", () => {
    const filter = createSpamFilter({ enabled: true, filterUnlisted: true });
    const result = filter.evaluate(unknown, { hasMetadata: false });
    expect(result.isSpam).toBe(true);
    expect(result.verdict).toBe("unlisted");
    expect(result.reason).toContain("SEP-1");
  });

  it("passes unlisted assets when filterUnlisted is off", () => {
    const filter = createSpamFilter({ enabled: true, filterUnlisted: false });
    const result = filter.evaluate(unknown, { hasMetadata: false });
    expect(result.isSpam).toBe(false);
    expect(result.verdict).toBe("unknown");
    expect(result.reason).toBeNull();
  });

  it("is case-insensitive on allow/blocklist keys", () => {
    const filter = createSpamFilter({
      enabled: true,
      filterUnlisted: true,
      blocklist: [`some:${ISSUER.toLowerCase()}`],
    });
    expect(filter.evaluate(unknown, { hasMetadata: true }).verdict).toBe("blocklisted");
  });
});