/**
 * @delegolabs/wallet — Entry point
 * TODO: Implement service logic
 */
import { createLogger } from "@delegolabs/utils";
import { startHttpServer, corsMiddleware, securityHeadersMiddleware, requireAuth } from "@delegolabs/utils";
import {
  SorobanTransactionSimulator,
  readSorobanRpcConfig,
} from "./sorobanSimulator.js";

const SERVICE_NAME = "wallet";
const DEFAULT_PORT = 3012;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.WALLET_PORT ?? DEFAULT_PORT);

const sorobanConfig = readSorobanRpcConfig();
log.info("Starting service", {
  port,
  nodeEnv,
  sorobanRpcTimeoutMs: sorobanConfig.timeoutMs,
  sorobanRpcMaxRetries: sorobanConfig.maxRetries,
});

export const sorobanSimulator = new SorobanTransactionSimulator(sorobanConfig);

import { registerRoutes } from "./routes.js";
import { startWebSocketServer, stopWebSocketServer } from "./websocket/server.js";
import { startBatchFlushTimers, stopBatchFlushTimers } from "./batching/batchQueue.js";
import { closeQueue } from "./queue/txQueue.js";
import { initSimulationCache } from "./simulationCache.js";
import { initDLQ } from "./queue/transactionDLQ.js";
import { getRedisConnection } from "./queue/txQueue.js";
import { balanceTracker } from "./assets/balances.js";

const server = startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  middleware: [corsMiddleware(), securityHeadersMiddleware(), requireAuth()],
  routes: registerRoutes(),
});

// Issue #41: Start WebSocket server on port 3013
startWebSocketServer();

// Issue #42: Start background batch flush timers
startBatchFlushTimers();

// Issue #141: Initialize simulation cache
try {
  const redis = getRedisConnection();
  initSimulationCache(
    {
      maxEntries: parseInt(process.env.SIM_CACHE_MAX_ENTRIES ?? "1000"),
      ttlSeconds: parseInt(process.env.SIM_CACHE_TTL_SECONDS ?? "300"),
      sharedCacheEnabled: process.env.SIM_CACHE_SHARED !== "false",
    },
    redis
  );
  log.info("Simulation cache initialized");
} catch (err) {
  log.error("Failed to initialize simulation cache", { error: (err as Error).message });
}

// Issue #143: Initialize transaction DLQ
try {
  const redis = getRedisConnection();
  initDLQ(redis);
  log.info("Transaction DLQ initialized");
} catch (err) {
  log.error("Failed to initialize transaction DLQ", { error: (err as Error).message });
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  log.info("Received shutdown signal", { signal });

  // Stop accepting new connections
  server.close(() => {
    log.info("HTTP server closed");
  });

  // Drain batch flush timers
  try {
    stopBatchFlushTimers();
    log.info("Batch flush timers stopped");
  } catch (err) {
    log.error("Error stopping batch flush timers", { error: (err as Error).message });
  }

  // Stop real-time balance trackers
  try {
    balanceTracker.stopAll();
    log.info("Balance trackers stopped");
  } catch (err) {
    log.error("Error stopping balance trackers", { error: (err as Error).message });
  }

  // Close WebSocket server
  try {
    await stopWebSocketServer();
    log.info("WebSocket server closed");
  } catch (err) {
    log.error("Error stopping WebSocket server", { error: (err as Error).message });
  }

  // Drain BullMQ queue and close Redis
  try {
    await closeQueue();
    log.info("Transaction queue closed");
  } catch (err) {
    log.error("Error closing transaction queue", { error: (err as Error).message });
  }

  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gracefulShutdown(signal);
  });
}

// TODO: Wire routes, database, and domain logic
