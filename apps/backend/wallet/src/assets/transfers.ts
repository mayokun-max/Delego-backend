/**
 * Asset transfer helpers — Issue #108.
 *
 * Send payments for every Stellar asset kind:
 *  - native / credit_alphanum4 / credit_alphanum12 via classic Payment ops
 *  - path payments (strict send / strict receive)
 *  - Soroban Stellar Asset Contract tokens via `transfer` invocation
 *  - liquidity pool deposits / withdrawals (pool shares are not
 *    transferable between accounts)
 */
import { Asset, Operation } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import type {
  AssetTransferRequest,
  AssetTransferResult,
  PathPaymentRequest,
} from "@delegolabs/types";
import type { TransactionRequest } from "@delegolabs/types";
import { addTransactionToQueue } from "../queue/txQueue.js";
import {
  buildSubmitter,
  paymentOp,
  pathPaymentStrictSendOp,
  type ClassicSubmitter,
} from "./submitter.js";
import { toSdkAsset } from "./utils.js";

export interface TransferServiceDeps {
  submitter?: ClassicSubmitter;
  /** Override the Soroban submit path (tests). */
  submitSoroban?: (request: TransactionRequest) => Promise<{
    hash: string;
    ledger: number;
    success: boolean;
  }>;
}

function toTransferResult(result: {
  hash: string;
  success: boolean;
  ledger?: number;
}): AssetTransferResult {
  return {
    hash: result.hash,
    success: result.success,
    ledger: result.ledger,
    submittedAt: new Date().toISOString(),
  };
}

export interface TransferService {
  /** Classic or SAC payment. SAC requires `contractId` on the request. */
  send(request: AssetTransferRequest): Promise<AssetTransferResult>;
  pathPayment(request: PathPaymentRequest): Promise<AssetTransferResult>;
  /** Deposit into a liquidity pool (mint pool shares). */
  liquidityPoolDeposit(request: {
    sourceAddress: string;
    poolId: string;
    maxAmountA: string;
    maxAmountB: string;
    minPrice: string;
    maxPrice: string;
    memo?: string;
  }): Promise<AssetTransferResult>;
  /** Withdraw from a liquidity pool (burn pool shares). */
  liquidityPoolWithdraw(request: {
    sourceAddress: string;
    poolId: string;
    amountStroops: string;
    minAmountA: string;
    minAmountB: string;
    memo?: string;
  }): Promise<AssetTransferResult>;
}

/** Classic payment to a destination account. */
async function sendClassic(
  submitter: ClassicSubmitter,
  request: AssetTransferRequest,
): Promise<AssetTransferResult> {
  const sdkAsset = toSdkAsset(request.asset);
  const op = paymentOp(request.destination, sdkAsset, request.amountStroops);
  const result = await submitter.submit({
    sourceAddress: request.sourceAddress,
    operations: [op],
    memo: request.memo,
  });
  return toTransferResult(result);
}

/** Soroban SAC token transfer via the resilient transaction queue. */
function sendSoroban(
  submitter: (request: TransactionRequest) => Promise<{ hash: string; ledger: number; success: boolean }>,
  request: AssetTransferRequest,
): Promise<AssetTransferResult> {
  if (!request.contractId) {
    throw new Error("SAC asset transfers require contractId on the request");
  }

  const txRequest: TransactionRequest = {
    sourceAddress: request.sourceAddress,
    contractId: request.contractId,
    method: "transfer",
    args: [request.sourceAddress, request.destination, request.amountStroops],
    argTypes: ["address", "address", "i128"],
    memo: request.memo ?? "Asset transfer",
    amountStroops: request.amountStroops,
  };

  return submitter(txRequest).then((result) => toTransferResult(result));
}

export function createTransferService(
  deps: TransferServiceDeps = {},
): TransferService {
  const submitter = deps.submitter ?? buildSubmitter();
  const submitSoroban = deps.submitSoroban ?? ((req) => addTransactionToQueue(req));

  return {
    async send(request) {
      if (!request.sourceAddress || !request.destination || !request.amountStroops) {
        throw new Error("sourceAddress, destination, and amountStroops are required");
      }
      if (!request.asset) throw new Error("asset is required");

      if (request.asset.type === "liquidity_pool") {
        throw new Error(
          "Liquidity pool shares are not transferable; use liquidityPoolDeposit / liquidityPoolWithdraw",
        );
      }

      // Soroban SAC token path.
      if (request.contractId) {
        return sendSoroban(submitSoroban, request);
      }
      return sendClassic(submitter, request);
    },

    async pathPayment(request) {
      if (!request.sourceAddress || !request.destination) {
        throw new Error("sourceAddress and destination are required");
      }
      if (request.sendAsset.type === "liquidity_pool") {
        throw new Error("Liquidity pool shares cannot be sent via path payment");
      }

      const path =
        request.path?.map((p) => toSdkAsset(p)) ??
        ([] as Asset[]);
      const op = pathPaymentStrictSendOp(
        request.destination,
        toSdkAsset(request.sendAsset),
        request.sendAmountStroops,
        toSdkAsset(request.destAsset),
        request.destMinAmountStroops,
        path,
      );
      const result = await submitter.submit({
        sourceAddress: request.sourceAddress,
        operations: [op],
        memo: request.memo,
      });
      return toTransferResult(result);
    },

    async liquidityPoolDeposit(request) {
      const op: xdr.Operation = Operation.liquidityPoolDeposit({
        liquidityPoolId: request.poolId,
        maxAmountA: request.maxAmountA,
        maxAmountB: request.maxAmountB,
        minPrice: request.minPrice,
        maxPrice: request.maxPrice,
      });
      const result = await submitter.submit({
        sourceAddress: request.sourceAddress,
        operations: [op],
        memo: request.memo,
      });
      return toTransferResult(result);
    },

    async liquidityPoolWithdraw(request) {
      const op: xdr.Operation = Operation.liquidityPoolWithdraw({
        liquidityPoolId: request.poolId,
        amount: request.amountStroops,
        minAmountA: request.minAmountA,
        minAmountB: request.minAmountB,
      });
      const result = await submitter.submit({
        sourceAddress: request.sourceAddress,
        operations: [op],
        memo: request.memo,
      });
      return toTransferResult(result);
    },
  };
}

export const transferService = createTransferService();