/**
 * WebSocket Transaction Status Server
 * Issue #41
 *
 * - Listens on port 3013
 * - Route: /ws/transactions/:address
 * - JWT authentication on connection upgrade
 * - Supports 1000+ concurrent connections per address
 * - 30-second ping/pong heartbeat
 * - Graceful cleanup on disconnect
 * - Emits TransactionStatusEvent within 100ms of status changes
 *
 * Uses Node.js built-in `http` + raw WebSocket upgrade (no ws library dependency)
 * to stay within the existing dependency set.  The ws library would be preferable
 * in production; the implementation below is swap-compatible.
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { createLogger } from "@delegolabs/utils";
import { verifyJwt } from "./auth.js";
import type {
  TransactionStatusEvent,
  AssetBalanceEvent,
  WSMessage,
} from "./types.js";

const log = createLogger("wallet:websocket", process.env.LOG_LEVEL ?? "info");

const WS_PORT = Number(process.env.WS_PORT ?? 3013);
const HEARTBEAT_INTERVAL_MS = 30_000;
const ADDRESS_PATTERN = /^\/ws\/transactions\/([^/]+)$/;

// ---------------------------------------------------------------------------
// Connection registry
// ---------------------------------------------------------------------------

export interface WsConnection {
  id: string;
  socket: net.Socket;
  address: string; // subscribed Stellar address
  isAlive: boolean;
  connectedAt: Date;
}

/** address -> Set<connection id> */
const subscriptions = new Map<string, Set<string>>();

/** connection id -> WsConnection */
const connections = new Map<string, WsConnection>();

// ---------------------------------------------------------------------------
// WebSocket frame encoding / decoding (RFC 6455)
// ---------------------------------------------------------------------------

function encodeFrame(payload: string): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const payloadLength = payloadBuffer.length;

  let headerBuffer: Buffer;
  if (payloadLength <= 125) {
    headerBuffer = Buffer.allocUnsafe(2);
    headerBuffer[0] = 0x81; // FIN + text frame
    headerBuffer[1] = payloadLength;
  } else if (payloadLength <= 65535) {
    headerBuffer = Buffer.allocUnsafe(4);
    headerBuffer[0] = 0x81;
    headerBuffer[1] = 126;
    headerBuffer.writeUInt16BE(payloadLength, 2);
  } else {
    headerBuffer = Buffer.allocUnsafe(10);
    headerBuffer[0] = 0x81;
    headerBuffer[1] = 127;
    headerBuffer.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  return Buffer.concat([headerBuffer, payloadBuffer]);
}

function encodePong(): Buffer {
  // Pong frame with empty payload
  const buf = Buffer.allocUnsafe(2);
  buf[0] = 0x8a; // FIN + pong opcode
  buf[1] = 0x00;
  return buf;
}

function encodePing(): Buffer {
  const buf = Buffer.allocUnsafe(2);
  buf[0] = 0x89; // FIN + ping opcode
  buf[1] = 0x00;
  return buf;
}

function decodeFrame(buffer: Buffer): {
  opcode: number;
  payload: string;
  isMasked: boolean;
} | null {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskingKey = masked ? buffer.slice(offset, offset + 4) : null;
  if (masked) offset += 4;

  if (masked && (!maskingKey || maskingKey.length !== 4)) return null;
  if (buffer.length < offset + payloadLength) return null;

  const payloadBuffer = buffer.slice(offset, offset + payloadLength);

  if (masked && maskingKey) {
    for (let i = 0; i < payloadBuffer.length; i++) {
      payloadBuffer[i] ^= maskingKey[i % 4];
    }
  }

  return {
    opcode,
    payload: payloadBuffer.toString("utf8"),
    isMasked: masked,
  };
}

// ---------------------------------------------------------------------------
// WebSocket handshake
// ---------------------------------------------------------------------------

function performHandshake(
  req: http.IncomingMessage,
  socket: net.Socket,
): boolean {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return false;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n"),
  );

  return true;
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

function sendMessage(socket: net.Socket, msg: WSMessage): void {
  try {
    socket.write(encodeFrame(JSON.stringify(msg)));
  } catch (err) {
    log.debug("Failed to send WS message", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function closeConnection(connId: string, code = 1000): void {
  const conn = connections.get(connId);
  if (!conn) return;

  // Graceful close frame
  try {
    const buf = Buffer.allocUnsafe(4);
    buf[0] = 0x88; // FIN + close
    buf[1] = 2;
    buf.writeUInt16BE(code, 2);
    conn.socket.write(buf);
    conn.socket.destroy();
  } catch {
    // already closed
  }

  const subs = subscriptions.get(conn.address);
  subs?.delete(connId);
  if (subs?.size === 0) subscriptions.delete(conn.address);

  connections.delete(connId);
  log.debug("WS connection closed", { connId, address: conn.address });
}

// ---------------------------------------------------------------------------
// Event broadcasting
// ---------------------------------------------------------------------------

/**
 * Broadcasts a TransactionStatusEvent to all connections subscribed to `address`.
 * Call this whenever a transaction status changes.
 */
export function broadcastTransactionEvent(
  address: string,
  event: TransactionStatusEvent,
): void {
  const subs = subscriptions.get(address);
  if (!subs || subs.size === 0) return;

  const msg: WSMessage = { type: "event", data: event };
  let sent = 0;

  for (const connId of subs) {
    const conn = connections.get(connId);
    if (conn) {
      sendMessage(conn.socket, msg);
      sent++;
    }
  }

  log.debug("Broadcast transaction event", {
    address,
    eventType: event.type,
    sent,
  });
}

export function getSubscriberCount(address: string): number {
  return subscriptions.get(address)?.size ?? 0;
}

/**
 * Broadcasts an AssetBalanceEvent to all connections subscribed to `address`.
 * Called by the BalanceTracker whenever a balance changes.
 */
export function broadcastBalanceEvent(
  address: string,
  event: AssetBalanceEvent,
): void {
  const subs = subscriptions.get(address);
  if (!subs || subs.size === 0) return;

  const msg: WSMessage = { type: "event", data: event };
  let sent = 0;

  for (const connId of subs) {
    const conn = connections.get(connId);
    if (conn) {
      sendMessage(conn.socket, msg);
      sent++;
    }
  }

  log.debug("Broadcast balance event", {
    address,
    eventType: event.type,
    changedAssets: event.changedAssets.length,
    sent,
  });
}

export function getTotalConnectionCount(): number {
  return connections.size;
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const toClose: string[] = [];
    for (const [connId, conn] of connections) {
      if (!conn.isAlive) {
        toClose.push(connId);
      } else {
        conn.isAlive = false;
        try {
          conn.socket.write(encodePing());
        } catch {
          toClose.push(connId);
        }
      }
    }
    for (const connId of toClose) {
      log.debug("Closing stale WS connection", { connId });
      closeConnection(connId, 1001);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

let wsServer: http.Server | null = null;

/**
 * Starts the WebSocket server on port 3013.
 * Returns the http.Server instance so callers can close it in tests.
 */
export function startWebSocketServer(port = WS_PORT): http.Server {
  if (wsServer) return wsServer;

  wsServer = http.createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade required");
  });

  wsServer.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    const url = req.url ?? "";
    const match = ADDRESS_PATTERN.exec(url);

    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const address = decodeURIComponent(match[1]);

    // JWT authentication via query param or header
    const rawUrl = new URL(url, "http://localhost");
    const token =
      rawUrl.searchParams.get("token") ??
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ??
      "";

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      log.warn("WS connection rejected: missing token", { address });
      return;
    }

    try {
      verifyJwt(token);
    } catch (err) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      log.warn("WS connection rejected: invalid token", {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!performHandshake(req, socket)) return;

    const connId = crypto.randomUUID();
    const conn: WsConnection = {
      id: connId,
      socket,
      address,
      isAlive: true,
      connectedAt: new Date(),
    };
    connections.set(connId, conn);

    if (!subscriptions.has(address)) {
      subscriptions.set(address, new Set());
    }
    subscriptions.get(address)!.add(connId);

    sendMessage(socket, {
      type: "ack",
      data: { message: `Subscribed to ${address}` },
    });

    log.info("WS connection established", { connId, address });

    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const frame = decodeFrame(buffer);
        if (!frame) break;

        const opcode = frame.opcode;

        // Consume the frame from the buffer (rough size calculation)
        let consumed = 2;
        const b1 = buffer[1] & 0x7f;
        if (b1 === 126) consumed += 2;
        else if (b1 === 127) consumed += 8;
        const masked = (buffer[1] & 0x80) !== 0;
        if (masked) consumed += 4;
        const payloadLen =
          b1 <= 125
            ? b1
            : b1 === 126
              ? buffer.readUInt16BE(2)
              : Number(buffer.readBigUInt64BE(2));
        consumed += payloadLen;
        buffer = buffer.slice(consumed);

        if (opcode === 0x9) {
          // Ping — respond with pong
          socket.write(encodePong());
        } else if (opcode === 0xa) {
          // Pong — mark alive
          conn.isAlive = true;
        } else if (opcode === 0x8) {
          // Close
          closeConnection(connId);
        } else if (opcode === 0x1 || opcode === 0x0) {
          // Text or continuation
          try {
            const msg = JSON.parse(frame.payload) as { action?: string };
            if (msg.action === "ping") {
              conn.isAlive = true;
              sendMessage(socket, { type: "pong", data: null });
            }
          } catch {
            // ignore malformed messages
          }
        }
      }
    });

    socket.on("close", () => closeConnection(connId));
    socket.on("error", () => closeConnection(connId));
  });

  wsServer.listen(port, () => {
    log.info(`WebSocket server listening on port ${port}`);
  });

  startHeartbeat();

  return wsServer;
}

/**
 * Stops the WebSocket server and clears all state.
 * Used in tests for clean shutdown.
 */
export function stopWebSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    // Close all open connections
    for (const connId of connections.keys()) {
      closeConnection(connId, 1001);
    }
    connections.clear();
    subscriptions.clear();

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (wsServer) {
      wsServer.close(() => {
        wsServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
