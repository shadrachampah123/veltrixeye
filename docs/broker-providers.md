# Broker execution providers (M8.4)

> **M8.4 does not enable live trading.** The MT5 transport shipped by the
> application is disabled and unconfigured. No broker connectivity is
> operational.

## Boundary

A broker adapter implements the normalized `ExecutionProvider` contract. An
MT5 adapter additionally depends on `MT5Transport`:

```
strategy → risk → decision → ExecutionProvider → MT5Provider → MT5Transport
```

Only the transport may communicate with a terminal, gateway, bridge, socket,
HTTP service, or vendor SDK. Strategy, risk, UI, routes, and persistence must
not import a transport implementation or broker payload type.

`DisabledMT5Transport` is the production M8.4 implementation. It returns an
honest unavailable health response and throws normalized `unavailable` errors
for every operation. It must not be replaced until deployment topology,
transport authentication, secret management, idempotency behavior, timeout
semantics, and demo validation are approved.

## Implementing a future transport

A future `MT5Transport` must provide health, account, symbol, order and position
operations defined in `packages/core/src/execution/mt5.ts`. Requirements:

1. Never accept or return credentials in domain records.
2. Obtain credentials through an approved external secret manager; profile
   rows may contain only opaque, non-secret references.
3. Distinguish configured, authenticated, connected, available and healthy.
4. Return actual MT5 records; never fabricate a successful account, quote,
   order, or position response.
5. Mark a timeout after possible acceptance as `responseLost`. The provider
   normalizes this to `uncertain`; never retry it blindly.
6. Support lookup by the stable platform client order id before submission.
   If duplicate safety cannot be established, fail closed.
7. Keep broker retcodes/messages bounded and secret-free. Translate failures
   with `normalizeMT5Error` before they enter the core domain or logs.
8. Validate quote timestamps and symbol metadata from the broker.
9. Validate only against explicit canonical-to-broker mappings. An order may
   not override its broker symbol.
10. Never round a risk-safe quantity upward to meet volume constraints.

Exness is treated exactly like any other MT5 broker/server. Do not introduce
Exness-specific strategy or risk logic. Do not claim compatibility is
operational until a transport has been validated against a real demo endpoint
without enabling live execution.

## Safety and API

The management API can inspect providers, create/update disabled demo profile
metadata, and test health. The connection test performs no order operation.
There is no broker submit/cancel/modify/close route in M8.4.

Live is blocked independently by the database, profile service, execution
gates, MT5 provider, disabled transport, automation switch and subscription
entitlement. A database/profile change alone can never activate execution.
