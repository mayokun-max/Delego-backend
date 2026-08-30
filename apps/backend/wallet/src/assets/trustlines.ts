/**
 * Trustline management — Issue #108.
 *
 * Create / update / delete trustlines (ChangeTrust) and issuer-side
 * authorization (SetTrustLineFlags) via classic Stellar transactions.
 * Signing uses the wallet vault; submission goes through the classic
 * submitter.
 */
import type {
  TrustlineChangeRequest,
  TrustlineAuthRequest,
  AssetTransferResult,
} from "@delegolabs/types";
import { toSdkAsset, fromStroops } from "./utils.js";
import {
  buildSubmitter,
  changeTrustOp,
  setTrustLineFlagsOp,
  type ClassicSubmitter,
} from "./submitter.js";

// Max canonical trustline limit (int64 max, expressed in stroops).
export const MAX_TRUSTLINE_LIMIT_STROOPS = "9223372036854775807";

export interface TrustlineServiceDeps {
  submitter?: ClassicSubmitter;
}

export interface TrustlineService {
  createOrUpdate(request: TrustlineChangeRequest): Promise<AssetTransferResult>;
  delete(request: TrustlineChangeRequest): Promise<AssetTransferResult>;
  authorize(request: TrustlineAuthRequest): Promise<AssetTransferResult>;
}

function assertCreditAsset(
  asset: { code: string; issuer?: string; type?: string },
  verb = "cannot hold a trustline for",
): void {
  if (asset.type === "liquidity_pool" || asset.type === "native") {
    throw new Error(`Native assets and liquidity pool shares ${verb}`);
  }
  if (!asset.issuer) {
    throw new Error("account and asset (code, issuer) are required");
  }
}

export function createTrustlineService(
  deps: TrustlineServiceDeps = {},
): TrustlineService {
  const submitter = deps.submitter ?? buildSubmitter();

  return {
    /** Create a new trustline or change an existing limit. */
    async createOrUpdate(request) {
      const { account, asset, limit } = request;
      if (!account || !asset?.code) {
        throw new Error("account and asset (code, issuer) are required");
      }
      assertCreditAsset(asset);

      const sdkAsset = toSdkAsset(asset);
      const limitStroops = (limit ?? MAX_TRUSTLINE_LIMIT_STROOPS).toString();
      if (limitStroops === "0") {
        throw new Error("Use DELETE to remove a trustline instead of a zero limit");
      }

      const op = changeTrustOp(sdkAsset, fromStroops(limitStroops));
      const result = await submitter.submit({
        sourceAddress: account,
        operations: [op],
      });

      return {
        hash: result.hash,
        success: result.success,
        ledger: result.ledger,
        submittedAt: new Date().toISOString(),
      };
    },

    /** Delete a trustline. Requires a zero balance on that line. */
    async delete(request) {
      const { account, asset } = request;
      if (!account || !asset?.code) {
        throw new Error("account and asset (code, issuer) are required");
      }
      assertCreditAsset(asset);

      const op = changeTrustOp(toSdkAsset(asset), fromStroops("0"));
      const result = await submitter.submit({
        sourceAddress: account,
        operations: [op],
      });

      return {
        hash: result.hash,
        success: result.success,
        ledger: result.ledger,
        submittedAt: new Date().toISOString(),
      };
    },

    /**
     * Set trustline authorization flags. The signing account must be the
     * asset issuer (or hold a management signer).
     */
    async authorize(request) {
      const { account, asset } = request;
      if (!account || !asset?.code) {
        throw new Error(
          "issuerAccount (source), trustor (account), and asset (code, issuer) are required",
        );
      }
      assertCreditAsset(asset, "cannot authorize a trustline for");

      const op = setTrustLineFlagsOp({
        trustor: account,
        asset: toSdkAsset(asset),
        authorized: request.authorized,
        authorizedToMaintainLiabilities: request.authorizedToMaintainLiabilities,
        clawbackEnabled: request.clawbackEnabled,
      });

      const result = await submitter.submit({
        sourceAddress: asset.issuer,
        operations: [op],
      });

      return {
        hash: result.hash,
        success: result.success,
        ledger: result.ledger,
        submittedAt: new Date().toISOString(),
      };
    },
  };
}

export const trustlineService = createTrustlineService();