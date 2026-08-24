# Creating strategy sessions without the Spectrum UI

How to create, configure, and control strategy-pack sessions by driving the
manager routes directly. This is what was used to arm `IPO Live`,
`Inverse Cramer Live`, and `Tracker Live` in Production on 2026-08-22.

Everything runs against `https://adaam.vercel.app/eve/v1/photon-workspaces`.

## 1. Get a manager token

Text Eve **"manage sessions"**. The reply contains a URL like:

```
https://adaam.vercel.app/eve/v1/photon-workspaces#<TOKEN>
```

The part after `#` is the capability token. **Valid for 2 hours**
(`MANAGER_TTL_SECONDS`, widened from 15 minutes in `51724bf`). It authorizes
every call below. It is owner-held: it must come from the owner directly, and
it must never be written into a file, commit, or log — this repository is
public.

```bash
TOKEN='paste-the-part-after-the-hash'
BASE=https://adaam.vercel.app/eve/v1/photon-workspaces
```

## 2. Read state

Everything else needs values from here.

```bash
curl -s -X POST "$BASE/state" -H 'Content-Type: application/json' \
  -d "{\"managerToken\":\"$TOKEN\"}" > state.json
```

Returns:

| Field | Use |
| --- | --- |
| `revision` | pass as `expectedRoutingRevision` / `expectedRevision` |
| `activeWorkspaceId` | the session your messages currently route to |
| `workspaces[]` | id, name, status, generation, monitors, budget, usage |
| `strategyPackCatalog[]` | installable packs, their config fields, monitor `resourceId`s |
| `packMutationIdentity` | **server-minted signature** — pass through verbatim |

`packMutationIdentity` is HMAC-signed and bound to the revision and active
workspace. You cannot construct it. Re-read state to get a fresh one.

The creation catalog shows **only the latest version of each pack**. Older
versions stay installable by exact version but are not listed.

## 3. Resolve an X identity (only for packs that pin one)

Packs with an `x_public_identity` field (e.g. Public Commentary Tracker)
require a signed resolution receipt at create time.

```bash
curl -s -X POST "$BASE/resolve-x-identity" -H 'Content-Type: application/json' \
  -d "{\"managerToken\":\"$TOKEN\",\"profile\":\"KobeissiLetter\",\"requestId\":\"$(uuidgen)\"}" \
  > ident.json
```

Returns `profileUrl`, `username`, `displayName`, `numericUserId`, and a
`resolutionReceipt`. The receipt is **valid 15 minutes** and is checked only on
create — configure does not accept it. This lookup runs untracked (no budget
reservation) since `0990fa2`.

## 4. Create a session

```bash
curl -s -X POST "$BASE/pack-action" -H 'Content-Type: application/json' -d '{
  "action": "strategy-pack-create",
  "managerToken": "'"$TOKEN"'",
  "packId": "ipo-filings",
  "packVersion": "1.1.2",
  "name": "IPO Live",
  "activateMonitorResourceIds": ["detect-new-s1"],
  "configuration": { "timezone": "America/Vancouver", "dailyTimes": ["10:00","16:00"] },
  "expectedRoutingRevision": 131,
  "packMutationIdentity": { "...from state.json..." },
  "sourceWorkspaceGeneration": 2,
  "sourceWorkspaceId": "<active workspace id>",
  "xIdentityResolutionReceipt": { "...from ident.json, X packs only..." }
}'
```

- `activateMonitorResourceIds: []` installs **paused**; listing the
  `resourceId` arms it immediately.
- `resourceId` comes from the catalog entry's `monitors[]`, e.g.
  `detect-new-s1`, `evaluate-public-commentary`, `compare-earnings-calls`.
- Success returns a `packMutation.receipt` with `outcome: "committed"`.

## 5. Session lifecycle — `POST /action`

`select`, `archive`, `restore`, `rename`, `start-fresh`, `delete`. Each needs
`expectedRevision`, `managerToken`, `requestId` (a UUID), `workspaceId`.

```bash
curl -s -X POST "$BASE/action" -H 'Content-Type: application/json' \
  -d "{\"action\":\"select\",\"expectedRevision\":131,\"managerToken\":\"$TOKEN\",\"requestId\":\"$(uuidgen)\",\"workspaceId\":\"<id>\"}"
```

## 6. Monitor control — `POST /runtime-action`

Not `/action`. Actions: `monitor-pause`, `monitor-resume`, `monitor-schedule`,
`workspace-budget`. These need `expectedMonitorRevision` (the monitor's
`configurationRevision`), `expectedRoutingRevision`, `monitorId`, `workspaceId`.

Reschedule a monitor without touching its pack config:

```bash
curl -s -X POST "$BASE/runtime-action" -H 'Content-Type: application/json' -d '{
  "action": "monitor-schedule",
  "managerToken": "'"$TOKEN"'",
  "requestId": "'"$(uuidgen)"'",
  "monitorId": "<monitorId>",
  "workspaceId": "<workspaceId>",
  "expectedMonitorRevision": 2,
  "expectedRoutingRevision": 131,
  "schedule": { "kind": "daily_local", "timezone": "America/Vancouver",
                "times": ["00:00","06:00","12:00","18:00"] }
}'
```

Schedule kinds: `daily_local` (up to 16 sorted unique `HH:MM`), `interval`
(`everyMinutes` ≥ 10 plus `anchor`), `one_time` (`at`), `source_event`.

## 7. Reconfigure — `POST /pack-action`

`strategy-pack-configure` with `confirmedConsequences: true`,
`expectedBindingRevision`, and the **full** configuration object.

Two things that bite:

- It targets `sourceWorkspaceId`, so **select the target session first**.
- Its schema is strict and has **no** `xIdentityResolutionReceipt` field —
  passing one returns 400.

## Gotchas that cost real time

| Symptom | Cause |
| --- | --- |
| `strategy_pack_invalid_request` | A list value isn't **sorted ascending**. `topics`, `impactHypotheses`, `selectedSymbols` all must be sorted and duplicate-free. |
| `strategy_pack_invalid_request` | An unknown configuration key, or a field marked `mutableAfterInstall: false` being changed. |
| `strategy_pack_invalid_request` on configure | You passed `xIdentityResolutionReceipt`. Create-only. |
| `duplicate_name` | Name is taken — **archived sessions still hold their names**. Rename the old one to free it. |
| `retained_capacity_exhausted` | Registry is full (48 retained records). Delete archived sessions to reclaim. |
| `409 stale` | `revision` moved. Re-read `/state` for a fresh `packMutationIdentity`. |
| `410` | Token expired. Ask the owner for a new one. |
| `503` + `storage_failure` | Sometimes a genuinely invalid session name — the registry caps names at **40 chars**. |
| Monitor action returns 400 | You posted to `/action` instead of `/runtime-action`. |

**Creating a pack session silently makes it the active session.** Always
`select` your intended session (usually `Main`) afterward, or your next
iMessage routes to the wrong agent.

**`xIdentity` is `mutableAfterInstall: false`.** A tracker cannot be repointed
at a different account — create a new session instead.

## Inspecting live state without the manager

Read-only checks against Redis, using `.env.local`:

```bash
set -a; . ./.env.local; set +a
# every monitor record
curl -s "$KV_REST_API_URL/scan/0/match/eve:workspace-runtime:v1:monitor:record:*/count/1000" \
  -H "Authorization: Bearer $KV_REST_API_TOKEN"
# the dispatch queue — what can actually fire, and when
curl -s "$KV_REST_API_URL/zrange/eve:workspace-runtime:v1:monitor:due/0/-1/WITHSCORES" \
  -H "Authorization: Bearer $KV_REST_API_TOKEN"
```

Useful key prefixes: `monitor:record:`, `monitor:due`, `monitor:inflight`,
`budget-ledger:`, `run-outcome:` (findings), `state:` (workspace documents).

A monitor is only dispatchable if `lifecycleState` is `enabled` **and** it has
a `nextOccurrenceAt`. Anything `paused`, `paused_failure`, `retired`, or
`suspended_archived` cannot fire.
