/**
 * Asset management API routes — Issue #108.
 *
 * Registered into the wallet service router. Provides trustline management,
 * balances, portfolio, discovery, spam settings, and transfer helpers for
 * native, credit, SAC, and liquidity-pool assets.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  route,
  json,
  isValidStellarPublicKey,
  readBodyWithLimit,
  PayloadTooLargeError,
  type Route,
} from "@delegolabs/utils";
import type {
  AssetReference,
  AssetTransferRequest,
  PathPaymentRequest,
  TrustlineChangeRequest,
  TrustlineAuthRequest,
} from "@delegolabs/types";
import { parseAssetKey } from "./utils.js";
import { discoverAsset, getCuratedAssets } from "./discovery.js";
import {
  getAccountBalances,
  balanceTracker,
  type BalancesDeps,
} from "./balances.js";
import { trustlineService } from "./trustlines.js";
import { getPortfolio, classifySpam } from "./portfolio.js";
import { transferService } from "./transfers.js";
import { createSpamFilter } from "./spamFilter.js";

const deps: BalancesDeps = {};

class AssetError extends Error {}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readBodyWithLimit(req);
  try {
    return body ? (JSON.parse(body) as T) : ({} as T);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function handleError(res: ServerResponse, err: unknown): void {
  if (err instanceof PayloadTooLargeError) {
    json(res, 413, {
      data: null,
      error: { code: "PAYLOAD_TOO_LARGE", message: err.message },
    });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  const lower = message.toLowerCase();
  const status = lower.includes("not found")
    ? 404
    : lower.includes("rate limit") || lower.includes("429")
      ? 429
      : lower.includes("not transferable") ||
          lower.includes("cannot hold") ||
          lower.includes("cannot remove") ||
          lower.includes("malformed") ||
          lower.includes("invalid") ||
          lower.includes("required")
        ? 400
        : 500;
  json(res, status, { data: null, error: { code: "ASSET_ERROR", message } });
}

function send(reason: string): never {
  throw new AssetError(reason);
}

function parseBodyAsset(body: { asset?: Partial<AssetReference> }): AssetReference {
  const asset = body.asset;
  if (!asset?.code) send("asset.code is required");
  const code = asset.code.trim();
  const type = asset.type ?? (code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12");
  const issuer = asset.issuer?.trim() ?? "";
  if (type === "native") {
    return { code: "XLM", issuer: "", type: "native" };
  }
  if (!issuer) send("asset.issuer is required for non-native assets");
  return { code, issuer, type };
}

function ensureAddress(value: string | undefined): string {
  if (!value) send("Stellar address is required");
  if (!isValidStellarPublicKey(value)) send("Malformed Stellar public key address");
  return value;
}

export function registerAssetRoutes(): Route[] {
  return [
    // ── Discovery & catalog ──────────────────────────────────────────────

    // Discover/refresh full descriptor for one asset reference.
    route("POST", "/api/v1/assets/discover", async (req, res) => {
      try {
        const ref = parseBodyAsset(await readJsonBody(req));
        const asset = await discoverAsset(ref, deps);
        json(res, 200, { data: asset, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Curated default catalog.
    route("GET", "/api/v1/assets", async (_req, res) => {
      try {
        const assets = await getCuratedAssets(deps);
        json(res, 200, { data: assets, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Asset detail: /api/v1/assets/USDC:GA5Z...
    route("GET", "/api/v1/assets/:assetRef", async (_req, res, params) => {
      try {
        const ref = parseAssetKey(params.assetRef);
        if (!ref) send("Malformed asset reference (expected CODE:ISSUER or XLM)");
        const asset = await discoverAsset(ref, deps);
        json(res, 200, { data: asset, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // ── Balances & portfolio ─────────────────────────────────────────────

    // All asset balances + trustlines for an account, with spam verdicts.
    route("GET", "/api/v1/wallet/:address/assets", async (_req, res, params) => {
      try {
        const address = ensureAddress(params.address);
        const { balances, trustlines, nativeBalance, lastUpdated } =
          await getAccountBalances(address, deps);
        const spam = await classifySpam(balances, deps);
        json(res, 200, {
          data: {
            address,
            nativeBalance,
            balances,
            trustlines,
            spam,
            lastUpdated,
          },
          error: null,
        });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Portfolio (cached, <200ms).
    route("GET", "/api/v1/wallet/:address/portfolio", async (_req, res, params) => {
      try {
        const address = ensureAddress(params.address);
        const portfolio = await getPortfolio(address, deps);
        json(res, 200, { data: portfolio, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // ── Trustline management ─────────────────────────────────────────────

    // List trustlines.
    route("GET", "/api/v1/wallet/:address/trustlines", async (_req, res, params) => {
      try {
        const address = ensureAddress(params.address);
        const { trustlines, lastUpdated } = await getAccountBalances(address, deps);
        json(res, 200, { data: { address, trustlines, lastUpdated }, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Create or update a trustline.
    route("POST", "/api/v1/wallet/:address/trustlines", async (req, res, params) => {
      try {
        const account = ensureAddress(params.address);
        const body = (await readJsonBody(req)) as { asset?: Partial<AssetReference>; limit?: string };
        const asset = parseBodyAsset(body);
        const request: TrustlineChangeRequest = { account, asset, limit: body.limit };
        const result = await trustlineService.createOrUpdate(request);
        json(res, 201, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Update a trustline limit.
    route("PATCH", "/api/v1/wallet/:address/trustlines/:assetRef", async (req, res, params) => {
      try {
        const account = ensureAddress(params.address);
        const ref = parseAssetKey(params.assetRef);
        if (!ref) send("Malformed asset reference");
        const body = (await readJsonBody(req)) as { limit?: string };
        if (!body.limit) send("limit is required");
        const request: TrustlineChangeRequest = { account, asset: ref, limit: body.limit };
        const result = await trustlineService.createOrUpdate(request);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Delete a trustline (limit -> 0).
    route("DELETE", "/api/v1/wallet/:address/trustlines/:assetRef", async (_req, res, params) => {
      try {
        const account = ensureAddress(params.address);
        const ref = parseAssetKey(params.assetRef);
        if (!ref) send("Malformed asset reference");
        const request: TrustlineChangeRequest = { account, asset: ref };
        const result = await trustlineService.delete(request);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Issuer-side authorization of a trustline.
    route("POST", "/api/v1/assets/:assetRef/authorize", async (req, res, params) => {
      try {
        const asset = parseAssetKey(params.assetRef);
        if (!asset) send("Malformed asset reference");
        const body = (await readJsonBody(req)) as {
          trustor: string;
          authorized?: boolean;
          authorizedToMaintainLiabilities?: boolean;
          clawbackEnabled?: boolean;
        };
        const trustor = ensureAddress(body.trustor);
        const request: TrustlineAuthRequest = {
          account: trustor,
          asset,
          authorized: body.authorized ?? false,
          authorizedToMaintainLiabilities: body.authorizedToMaintainLiabilities,
          clawbackEnabled: body.clawbackEnabled,
        };
        const result = await trustlineService.authorize(request);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // ── Transfers ────────────────────────────────────────────────────────

    // Send a payment (classic or SAC).
    route("POST", "/api/v1/assets/transfer", async (req, res) => {
      try {
        const body = (await readJsonBody(req)) as AssetTransferRequest;
        ensureAddress(body.sourceAddress);
        ensureAddress(body.destination);
        if (!body.amountStroops) send("amountStroops is required");
        body.asset = parseBodyAsset({ asset: body.asset });
        const result = await transferService.send(body);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Path payment (strict send).
    route("POST", "/api/v1/assets/path-payment", async (req, res) => {
      try {
        const body = (await readJsonBody(req)) as PathPaymentRequest;
        ensureAddress(body.sourceAddress);
        ensureAddress(body.destination);
        if (!body.sendAmountStroops || !body.destMinAmountStroops) {
          send("sendAmountStroops and destMinAmountStroops are required");
        }
        body.sendAsset = parseBodyAsset({ asset: body.sendAsset });
        body.destAsset = parseBodyAsset({ asset: body.destAsset });
        body.path = (body.path ?? []).map((p: Partial<AssetReference>) =>
          parseBodyAsset({ asset: p }),
        );
        const result = await transferService.pathPayment(body);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Liquidity pool deposit.
    route("POST", "/api/v1/assets/liquidity-pool/deposit", async (req, res) => {
      try {
        const body = (await readJsonBody(req)) as {
          sourceAddress: string;
          poolId: string;
          maxAmountA: string;
          maxAmountB: string;
          minPrice: string;
          maxPrice: string;
          memo?: string;
        };
        ensureAddress(body.sourceAddress);
        if (!body.poolId) send("poolId is required");
        const result = await transferService.liquidityPoolDeposit(body);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Liquidity pool withdraw.
    route("POST", "/api/v1/assets/liquidity-pool/withdraw", async (req, res) => {
      try {
        const body = (await readJsonBody(req)) as {
          sourceAddress: string;
          poolId: string;
          amountStroops: string;
          minAmountA: string;
          minAmountB: string;
          memo?: string;
        };
        ensureAddress(body.sourceAddress);
        if (!body.poolId) send("poolId is required");
        const result = await transferService.liquidityPoolWithdraw(body);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // ── Real-time tracking ───────────────────────────────────────────────

    // Start real-time balance tracking (WebSocket push on change).
    route("POST", "/api/v1/wallet/:address/assets/track", async (_req, res, params) => {
      try {
        const address = ensureAddress(params.address);
        balanceTracker.start(address);
        json(res, 200, {
          data: { address, tracking: true, pollIntervalSeconds: 30 },
          error: null,
        });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Stop real-time balance tracking.
    route("DELETE", "/api/v1/wallet/:address/assets/track", async (_req, res, params) => {
      try {
        const address = ensureAddress(params.address);
        balanceTracker.stop(address);
        json(res, 200, {
          data: { address, tracking: false },
          error: null,
        });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // ── Spam filter ──────────────────────────────────────────────────────

    // Current spam filter configuration (sources from env).
    route("GET", "/api/v1/assets/spam/settings", async (_req, res) => {
      try {
        const filter = createSpamFilter();
        json(res, 200, { data: filter.settings, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),
  ];
}