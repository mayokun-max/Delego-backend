# Asset Management

The wallet service's asset management module (Issue #108) provides balance tracking, trustline management, asset discovery, portfolio aggregation, spam filtering, and transfer helpers for every Stellar asset kind — native XLM, credit assets (alphanum4/alphanum12), Soroban Stellar Asset Contract (SAC) tokens, and liquidity pool shares.

## 📋 Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Asset Discovery](#asset-discovery)
- [Balances & Portfolio](#balances--portfolio)
- [Trustline Management](#trustline-management)
- [Transfers](#transfers)
- [Real-Time Tracking](#real-time-tracking)
- [Spam Filtering](#spam-filtering)
- [Unit Representation](#unit-representation)
- [Testing](#testing)

## Overview

The module lives in `apps/backend/wallet/src/assets/` and is exposed through the wallet HTTP router via `registerAssetRoutes()` (`src/assets/routes.ts`). Every endpoint validates Stellar addresses with `isValidStellarPublicKey` and returns the unified `{ data, error }` envelope used across the wallet service.

Module layout:

```
apps/backend/wallet/src/assets/
├── routes.ts        # HTTP routes
├── config.ts        # Stellar network + ASSET_* feature config
├── utils.ts         # asset keys, stroops conversion, SDK mapping
├── discovery.ts     # descriptors, issuer flags, curated catalog
├── metadata.ts      # SEP-1 metadata resolver
├── balances.ts      # horizon balances + BalanceTracker
├── portfolio.ts     # cached portfolio aggregation
├── trustlines.ts    # changeTrust / setTrustLineFlags
├── transfers.ts     # classic payments, SAC, path payments, LP ops
└── spamFilter.ts    # deterministic spam rules
```

Shared types (`Asset`, `AssetBalance`, `Trustline`, `Portfolio`, `SpamFilterSettings`, transfer request/result types) live in `packages/types/src/assets.ts`.

## Configuration

Stellar network resolution (`src/assets/config.ts`):

| Variable | Default | Description |
| --- | --- | --- |
| `STELLAR_NETWORK` | `testnet` | `testnet`, `mainnet` or `futurenet` |
| `STELLAR_HORIZON_URL` | per network | Horizon base URL override |
| `STELLAR_RPC_URL` | per network | Soroban RPC URL override |

Asset feature configuration (`ASSET_*`, `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `ASSET_METADATA_CACHE_TTL_SECONDS` | `3600` | TTL for cached SEP-1 metadata |
| `ASSET_BALANCE_POLL_INTERVAL_SECONDS` | `30` | Real-time balance poll interval |
| `ASSET_PORTFOLIO_CACHE_SECONDS` | `5` | Portfolio Redis TTL |
| `ASSET_SPAM_FILTER_ENABLED` | `true` | Master switch for spam filtering |
| `ASSET_SPAM_FILTER_UNLISTED` | `false` | Hide assets with no published SEP-1 metadata |
| `ASSET_SPAM_ALLOWLIST` | `XLM` | Always-allowed `CODE:ISSUER` / `XLM` entries (comma-separated) |
| `ASSET_SPAM_BLOCKLIST` | *(empty)* | Always-filtered `CODE:ISSUER` entries |
| `ASSET_MAX_BALANCES` | `500` | Max balances surfaced before spam filters apply |

## Asset Discovery

Discovery builds full `Asset` descriptors from a minimal `CODE` / `ISSUER` reference:

- **Type normalization** — alphanum4/alphanum12 based on code length.
- **Issuer flags** — `auth_required`, `auth_revocable`, `auth_immutable` fetched from Horizon and cached (24h, Redis + in-memory fallback).
- **SAC contract id** — deterministic from `Asset.contractId(passphrase)` for credit assets.
- **SEP-1 metadata** — name, symbol, logo, home domain resolved and cached.

```
GET /api/v1/assets               Curated catalog (XLM, USDC, BTC, ETH)
GET /api/v1/assets/:assetRef     One descriptor, e.g. USDC:GA5ZSEJ...
POST /api/v1/assets/discover     Refresh descriptor from a partial ref in the body
POST /api/v1/assets/:assetRef/authorize   Issuer-side trustline authorization
```

The curated catalog (`DEFAULT_CATALOG`) uses the USDC mainnet issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`.

## Balances & Portfolio

### Account balances

Maps a Horizon account's `balances[]` into `AssetBalance` models plus trustlines. Native balance is always first; liquidity pool shares become `liquidity_pool` entries. Liabilities are surfaced as `locked` / `available`.

```
GET /api/v1/wallet/:address/assets
```

Response: `{ address, nativeBalance, balances[], trustlines[], spam[], lastUpdated }`.

### Portfolio

Aggregates balances + discovery metadata into a `Portfolio` with an optional total USD value. Results are cached in Redis (memory-first) to keep the endpoint under 200 ms.

```
GET /api/v1/wallet/:address/portfolio
```

## Trustline Management

Trustline operations build real transactions and submit them through the wallet submitter:

- `createOrUpdate` — `Operation.changeTrust`, decimal limit in stroops.
- `delete` — `changeTrust` with a zero limit (per protocol, the canonical deletion).
- `authorize` — `Operation.setTrustLineFlags` from the issuer's account (`flags.authorized`, `authorizedToMaintainLiabilities`, `clawbackEnabled`).

```
GET    /api/v1/wallet/:address/trustlines
POST   /api/v1/wallet/:address/trustlines          { asset, limit? }
PATCH  /api/v1/wallet/:address/trustlines/:assetRef { limit }
DELETE /api/v1/wallet/:address/trustlines/:assetRef
```

Limits and balances use **decimal strings** via `fromStroops()` / `toStroops` throughout.

## Transfers

`POST /api/v1/assets/transfer` sends either a classic payment or a Soroban SAC transfer:

- No `contractId` → classic `payment` op.
- `contractId` present → SAC `transfer` invocation through the resilient transaction queue (`argTypes: ["address", "address", "i128"]`).
- `liquidity_pool` assets are rejected — use the LP deposit/withdraw ops instead.

```
POST /api/v1/assets/transfer                      Classic or SAC payment
POST /api/v1/assets/path-payment                  Strict-send path payment
POST /api/v1/assets/liquidity-pool/deposit        Mint pool shares
POST /api/v1/assets/liquidity-pool/withdraw       Burn pool shares
```

Amounts are always transmitted as integer stroops (`amountStroops`, `sendAmountStroops`).

## Real-Time Tracking

Starting tracking for an address polls Horizon every `ASSET_BALANCE_POLL_INTERVAL_SECONDS` seconds and pushes a WebSocket `balances_updated` event whenever a balance changes.

```
POST   /api/v1/wallet/:address/assets/track
DELETE /api/v1/wallet/:address/assets/track
```

The tracker pushes an event with a full `balances` map (assetKey → stroops) plus `changedAssets` (only the keys that moved). On the first poll every holding counts as changed. The tracker is stopped for all addresses on wallet shutdown (`index.ts` → `balanceTracker.stopAll()`).

## Spam Filtering

The deterministic `createSpamFilter()` evaluates each asset against the active settings and returns a verdict — `allowed`, `blocklisted`, `unlisted`, or `unknown`:

1. Filter disabled → `allowed`.
2. Native assets (`XLM`) and allowlist entries → `allowed`.
3. Blocklist entries → `blocklisted` (spam).
4. `filterUnlisted` enabled and no SEP-1 metadata → `unlisted` (spam).
5. Otherwise → `unknown` (kept, unverified).

```
GET /api/v1/assets/spam/settings
```

Rules are synchronous and pure, reading configuration via `readAssetServiceConfig()`.

## Unit Representation

- **On-chain amounts** are integer stroops (7 decimal places). Horizon decimals such as `"10.0000000"` convert via `toStroops()` → `"100000000"`.
- **Trustline limits** are decimal strings in operations (e.g. `"1000000000"` for the max lacunal limit resolver) — see `changeTrustOp().limit().toBigInt()` in tests.
- **Asset keys** are canonical: `XLM` (native), `CODE:ISSUER` (credit), `LP:POOLID` (liquidity pool). Used for maps, cache keys, and allow/blocklists.

## Testing

The module is covered by vitest suites under `src/assets/` (`utils`, `config`, `spamFilter`, `discovery`, `transfers`, `trustlines`, `balances`, `portfolio`). Run:

```bash
pnpm --filter @delegolabs/wallet test
pnpm --filter @delegolabs/wallet exec vitest run src/assets
pnpm --filter @delegolabs/wallet typecheck
```

---

**Last Updated**: August 2026