# Architecture — Axis Nexus Autonomous Options Trading System

DhanHQ-TS execution core that trades options **autonomously** — the backend
runs as a long-lived, headless process; the browser frontend is an optional
control plane (monitor / configure / start-stop), never a dependency.

```
                                ┌──────────────────────────────────────────┐
                                │            BACKEND PROCESS               │
                                │      (server.ts HTTP+WS | index.ts       │
                                │       headless sidecar — same core)      │
                                │                                          │
   DhanHQ v2 Cloud  ◄──────────►│  ┌────────────────────────────────────┐  │
   REST (HTTPS)                 │  │         startCore() (core.ts)      │  │
   Binary WebSocket (ticks)     │  │                                    │  │
   Order updates                │  │  MarketDataService ──ticks──► RiskEngine
                                │  │       │  ▲                │        │  │
                                │  │       │  └── exit signals ─┤        │  │
                                │  │       ▼                     ▼        │  │
                                │  │  PositionMonitor      AutonomyEngine │  │
                                │  │  (SL/target/trail)    (2s loop, EOD) │  │
                                │  │       │                     │        │  │
                                │  │       ▼                     ▼        │  │
                                │  │  PaperEngine / LiveEngine ◄─┘        │  │
                                │  │       ▲                              │  │
                                │  │  AgentOrchestrator (6-persona ReAct, │  │
                                │  │   44 policy-gated SDK tools)         │  │
                                │  │       ▲                              │  │
                                │  │  EventBus ◄── every service          │  │
                                │  └──────────┬───────────────────────────┘  │
                                │             │                              │
                                │     ┌───────┼─────────┬────────────┐       │
                                │     ▼       ▼         ▼            ▼       │
                                │  WS hub   Redis     PostgreSQL   Pino     │
                                │  (/ws)   pub/sub    (optional)   stdout   │
                                │     │   (optional)  (optional)  (JSON)   │
                                └─────┼───────────────────────────────────┘
                                      │ typed envelopes
                                      ▼
                        ┌─────────────────────────────┐
                        │   FRONTEND (control plane)  │
                        │   React 19 + Vite SPA       │
                        │   REST snapshot + WS live   │
                        │   zero trading logic        │
                        └─────────────────────────────┘
```

## 1. Process topology

Two entry points boot the **identical** autonomous core via `startCore()`:

| Entry | Command | HTTP/WS | Use |
|---|---|---|---|
| Control-plane server | `npm start` | :3003 REST + `/ws` | Normal operation; frontend attaches here |
| Headless sidecar | `npm run start:headless` | none | Rails-integration / constrained hosts |

Both register `uncaughtException` / `unhandledRejection` guards logged at
`fatal` — a crashed backend leaves live positions unmonitored, so the core
survives async surprises and keeps trading.

**Degradation ladder** (nothing but DhanHQ credentials is mandatory):

- PostgreSQL unreachable → in-memory paper state (`dbMode() === 'memory'`), reported by `/api/health`
- Redis unreachable → pub/sub bridge and legacy intent listener become no-ops
- Ollama unreachable → agent runs in labeled deterministic mode (real tools, template reasoning — no fabricated analysis)
- DhanHQ WS down → market data falls back to REST polling; ticks carry staleness

## 2. Core services (`src/services/`)

### EventBus (`eventBus.ts`) — the spine
Typed in-process pub/sub. Every service publishes envelopes
`{ channel, ts, payload }` on channels: `tick | log | alert | telemetry |
risk | portfolio | order | system`. The bus fans out to the WS hub (UI),
Redis pub/sub (Rails bridge) and a 500-envelope history buffer used to
hydrate late-attaching WS clients with *real* history. Services never know
whether a frontend exists — this is the seam that makes the backend
frontend-free.

### MarketDataService (`marketData.ts`) — always-on feeds
- Primary: DhanHQ binary WebSocket (index LTPs; extra instrument
  subscriptions on demand), started best-effort at boot.
- Fallback: REST `marketFeed.quote` polling every 3s while WS is down.
- Tracks source (`ws | rest | none`) and tick age — the risk engine's
  Stale Market Tick breaker consumes this.
- Feeds the SDK `PositionMonitor` (stop-loss / target / trailing exits);
  monitor `exit` events are re-emitted on the bus as `order` /
  `exit_signal` envelopes for the autonomy engine to act on.
- Publishes `tick` envelopes with the five index quotes
  (NIFTY 13, BANKNIFTY 25, FINNIFTY 27, MIDCPNIFTY 442, INDIAVIX 26).

### RiskEngine (`riskEngine.ts`) — the guardian
Recomputes six circuit breakers from **real** account state on a fixed
interval and on demand:

| Breaker | Computed from | Effect |
|---|---|---|
| Daily Loss Limit | realized + mark-to-market PnL vs `RISK_DAILY_MAX_LOSS` | **hard** — auto-arms kill switch |
| Margin Utilization | wallet margin vs threshold | hard-cap alerting |
| Consecutive Losses | fill history | throttle |
| Order Rejection Rate | order-flow stats (≥5 orders) | throttle |
| Stale Market Tick | tick age during market hours | `canTrade()` blocks new entries |
| EOD Square-Off Proximity | IST clock 15:20–15:30 | de-risk warning |

- `canTrade()` is the single gate **every** order path funnels through —
  manual UI orders, strategy deploys, agent executions, Redis intents.
- Kill switch (armed by hard breakers or manually): squares off every
  paper position, engages DhanHQ Trader's Control kill switch in live
  mode, persists state, emits `system` envelopes.
- Limits are live-tunable at runtime via `POST /api/control/risk-limits`.
- Alert **state transitions only** (no alert storms).

### AutonomyEngine (`autonomy.ts`) — the 24×7 loop
Self-rescheduling cycle: **every 2s while the market is open**, 30s
otherwise, 5s after an error:

1. **Mark-to-market** all positions from live ticks (`markPositionsToMarket`),
   then publish a portfolio snapshot.
2. **Strategy guardrails** — any RUNNING strategy whose PnL breaches its
   per-strategy loss limit gets its legs squared off automatically.
3. **Exit signals** — subscribes to `exit_signal` envelopes from
   PositionMonitor and closes positions autonomously (SL / target /
   trailing), logging `TRADE` events with fill price and reason.
4. **EOD square-off** — one-shot per IST trading day at 15:20–15:30,
   closes everything (latch resets on date change; suppressed when killed).

### AgentOrchestrator (`agent.ts`) — optional agentic brain
Six-persona ReAct pipeline: **planner → analyst → strategy → risk →
execution → critic**, streamed as `telemetry` envelopes.

- Personas `analyst` / `execution` call the SDK `AgentToolRegistry` —
  44 real DhanHQ tools behind a permission policy (dhan_ltp,
  dhan_option_chain, dhan_funds, dhan_positions, order placement…).
- Reasoning: Ollama (`@nemesis-oss/ollama-sdk`) when reachable; otherwise
  a **deterministic, explicitly-labeled** fallback. Every step records
  `llm: ollama | deterministic` — no fabricated analysis text, ever.
- An agent trade executes only when the objective demands it, an ATM
  strike resolves from the live chain, `canTrade()` allows, and zero
  breakers are tripped — the agent cannot bypass the risk gate.
- Runs persist step/tool events to `agent_events` (Postgres or memory).

### marketHours (`marketHours.ts`)
Pure IST clock (UTC+5:30 math, host-timezone-independent): pre-open,
regular session 09:15–15:30, post-close, square-off window 15:20–15:30,
weekend awareness. Every function accepts an injectable instant for tests.

## 3. Execution engines (`src/engines/`)

| | Paper (`paper.ts`) | Live (`live.ts`) |
|---|---|---|
| Order routing | in-process matching | DhanHQ REST order API |
| Fill price | **live LTP ± slippage**; unpriceable orders **REJECTED** (never `price‖100`) | order-update WS → OrderTracker → fill events |
| Risk gate | `canTrade()` before every fill | same |
| Post-fill | SL/target/trail via PositionMonitor; Redis fill publish | same + `dhan:execution:fills` |
| Telemetry | `order` envelopes (fill/rejection) | same |

`TRADING_MODE=paper|live` selects the active engine everywhere at once.

## 4. Control plane surface

**REST** (Express 5, JSON, request-id correlated):

- `/api/health` — mode, persistence, kill/autonomy flags, tick source, uptime
- `/api/market/*` — indices, option chain, quotes, Black-Scholes Greeks
  (from live chain), rolling/expired-option candles via SDK
- `/api/portfolio/*` — positions/orders/trades/funds/holdings/profile,
  paper trading (order, close, wallet reset, strategy deploy/close),
  margin calculation — every write gated by the risk engine
- `/api/control/*` — state, kill switch arm/reset, autonomy toggle,
  square-off, risk limits (get/post), agent run/status/events/tools,
  alerts (+ test)
- `/api/infra/stats` — real service telemetry (market data, risk,
  autonomy, agent, WS hub) — no fabricated worker rows
- `/api/client-logs` — frontend log ingest (zod-validated, rate-limited)
- `/api/ollama/*` — honest 503 when the LLM is unreachable

**WebSocket `/ws`** — typed envelope stream. Client sends
`{type:'subscribe',channels:[…]}`; on connect receives a hydration
snapshot (last ~60 log/alert/telemetry envelopes) so late dashboards show
real history immediately. Ping/pong supported.

## 5. Observability

Structured logging spans both sides with one vocabulary (see README
*Observability & logging*):

- Pino JSON on stdout — base fields `service/env/version/mode` + `module`;
  ISO 8601 timestamps; secret redaction (DhanHQ tokens, TOTP secrets,
  PINs, auth headers).
- `pino-http` access logs with `x-request-id` reuse/echo, W3C
  `traceparent` traceId/spanId correlation, `/api/health` excluded.
- **Bus→stdout bridge**: every UI-bound event (logs, alerts, order
  fills/rejections, lifecycle) mirrored into the same stream under a
  per-minute flood budget — one query (`requestId=…`) spans frontend,
  HTTP layer and trading core.
- Frontend logger (sampled, batched, `sendBeacon`), per-region React
  ErrorBoundary, global error/rejection handlers.

## 6. Persistence (`src/db.ts`)

PostgreSQL tables: `paper_wallet`, `paper_orders` (with realized PnL and
order latency), `paper_positions`, `paper_strategies`,
`options_behavior_analysis`, plus operational tables `alerts`,
`agent_events`, `risk_state`. Identical function surface in memory mode —
callers never branch on persistence.

## 7. Integration: legacy Rails bridge

The headless sidecar subscribes to `dhan:execution:intents` (Redis) and
executes intents through the same gated engines; core events mirror to
`dhan:events:*` channels; token rotation notices on `dhan:auth:rotated`
are picked up by the SDK client's token provider. Redis absent ⇒ bridge
silent, core unaffected.

## 8. Design invariants

1. **Backend autonomy** — every trading decision runs with zero frontend
   attached; the UI is an observer with buttons.
2. **One risk gate** — manual, agentic and bridged orders all pass
   `canTrade()`; hard breakers arm the kill switch without asking.
3. **No fabricated data** — unpriceable ⇒ rejected; unreachable ⇒ honest
   503/error; deterministic agent mode is labeled as such.
4. **Never crash on surprises** — process-level guards + per-cycle
   try/catch with backoff scheduling.
5. **IST-true clock** — market/EOD logic identical on any host timezone.
6. **Graceful degradation** — Postgres/Redis/Ollama/WS all optional;
   only DhanHQ credentials are required to trade.
