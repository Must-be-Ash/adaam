# Local workspace schedule test

This runbook exercises the real Eve development schedule-dispatch route against a
disposable local Redis. It does not use deployment credentials, Photon, or a live
broker. Run it from the repository root.

## 1. Verify deterministic scheduling first

```sh
node_modules/.bin/jiti scripts/verify-workspace-monitor-schedule.ts
REDIS_SERVER_BIN=/absolute/path/to/redis-server \
  node_modules/.bin/jiti scripts/verify-workspace-runtime-redis.ts
```

Both commands must pass before testing the HTTP dispatch path.

## 2. Start disposable storage

Use an empty local Redis on port 6389. In terminal one:

```sh
/absolute/path/to/redis-server \
  --bind 127.0.0.1 --port 6389 --save '' --appendonly no
```

Eve's workspace stores use the Upstash REST protocol, while Photon Chat SDK state uses
the Redis protocol. The local-only proxy adapts the former to the same disposable Redis.
In terminal two:

```sh
LOCAL_REDIS_URL=redis://127.0.0.1:6389 \
LOCAL_REDIS_REST_PORT=8079 \
  node scripts/local-redis-rest-proxy.mjs
curl --fail http://127.0.0.1:8079/health
```

## 3. Start Eve development mode

In terminal three, use fixture identities and secrets only:

```sh
KV_REST_API_URL=http://127.0.0.1:8079 \
KV_REST_API_TOKEN=local-only \
REDIS_URL=redis://127.0.0.1:6389 \
EVE_DEPLOYMENT_OWNER_ID=owner_local \
EVE_PHOTON_OWNER_PRINCIPALS=imessage:local-owner \
EVE_OWNER_ALIAS_HMAC_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
EVE_WORKSPACE_RUNTIME_AUTH_SECRET=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB \
EVE_WORKSPACE_STATE_ENABLED=1 \
EVE_WORKSPACE_MONITOR_WRITES_ENABLED=1 \
EVE_WORKSPACE_DISPATCH_ENABLED=1 \
EVE_WORKSPACE_PAID_RESEARCH_ENABLED=0 \
EVE_PHOTON_WORKSPACE_ALERTS_ENABLED=0 \
EVE_WORKSPACE_SOURCE_EVENTS_ENABLED=0 \
EVE_LEGACY_TRIGGER_CREATION_ENABLED=0 \
SEC_USER_AGENT='adaam-local-schedule-test local@example.invalid' \
  node_modules/.bin/eve dev --no-ui --host 127.0.0.1 --port 2000
```

`eve dev` deliberately does not run cron automatically. Waiting for a minute boundary
is therefore not a valid local test.

## 4. Dispatch exactly one minute-schedule pass

From terminal four:

```sh
curl --fail-with-body -X POST \
  http://127.0.0.1:2000/eve/v1/dev/schedules/event-triggers
```

An empty disposable store returns a successful JSON response for the one requested
dispatch and starts no worker. Repeat only when you intentionally want another pass.
The route is development-only and is absent from production builds.

The internal runner route is not a manual scheduler endpoint. Its public handler returns
404 deliberately; Eve reaches the channel through its in-process `to(...)` handoff:

```sh
test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  http://127.0.0.1:2000/eve/v1/internal/event-trigger-runner)" = 404
```

## 5. Stop and discard

Stop Eve, the REST proxy, and Redis with Ctrl-C. Because Redis persistence was disabled,
the fixture state is discarded. Never substitute production Redis or deployment
credentials in this runbook.
