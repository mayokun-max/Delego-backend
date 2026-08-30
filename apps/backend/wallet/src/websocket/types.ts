/**
 * WebSocket Transaction Status & Balance Updates — shared types
 * Issues #41, #108
 */

export type TxEventType = "submitted" | "confirmed" | "failed";
export type TxStatus = "pending" | "success" | "failed";

export interface TransactionStatusEvent {
  type: TxEventType;
  transactionHash: string;
  ledger: number | null;
  status: TxStatus;
  /** ISO 8601 */
  timestamp: string;
  errorMessage: string | null;
}

/** Real-time balance update pushed when an account's holdings change. */
export interface AssetBalanceEvent {
  type: "balances_updated";
  address: string;
  /** assetKey -> balance (stroops) after the change. */
  balances: Record<string, string>;
  /** Canonical asset keys that changed since the last snapshot. */
  changedAssets: string[];
  /** ISO 8601 */
  timestamp: string;
}

export type WSAction = "subscribe" | "unsubscribe";

export interface WSSubscriptionMessage {
  action: WSAction;
  address: string;
  /** JWT bearer token */
  token: string;
}

export interface WSError {
  code: string;
  message: string;
}

export interface WSMessage {
  type: "event" | "error" | "ack" | "pong";
  data: TransactionStatusEvent | AssetBalanceEvent | WSError | { message: string } | null;
}