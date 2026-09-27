# Agents Anywhere (AA) — Operations Runbook

> Companion to [`2026-09-27-zai-aa-integration.md`](2026-09-27-zai-aa-integration.md).
> Read that first for architecture; this is the practical "what to do when" guide.

---

## TL;DR

zai is **opt-in** for AA. To enable:

```bash
# Stop current zai (without --aa), then restart with the flag.
zai start --aa
```

The first time you do this, zai will show **"unpaired"** in Settings → AA 桥. Click **启动配对**, then go to AA Web → 我的设备 → 添加设备 → enter the 8-digit code → paste back the `cxt_xxx` token. Done.

After that, every restart `zai start --aa` reconnects automatically.

---

## Day-to-day ops

### Check current AA status

Settings page → AA 桥 tab → status badge shows:

| Badge | What it means | Action |
|---|---|---|
| **Disabled** | zai started without `--aa` | restart with `zai start --aa` |
| **Unpaired** | `--aa` set, but no `~/.zai/aa/config.json` | click 启动配对 |
| **Uninitialized** | paired, but AA client hasn't started yet | restart zai |
| **Connected** | WS to AA server is up | — |
| **Reconnecting (N)** | WS dropped, retrying | usually self-heals; if stuck see below |
| **Closed** | shut down cleanly | restart zai |

Server-side log:
```bash
# Browser console shows WS state via the AASettings page.
# Backend logs (in zai terminal) prefix with [aa.client] / [aa.runtimeRegistry].
```

### Restart pairing (after token rotation)

AA Web → 我的设备 → revoke the old zai connector → copy the new `cxt_xxx` → paste into Settings → AA 桥 → 取消 → 启动配对.

Or from CLI:
```bash
rm ~/.zai/aa/config.json  # drop the saved config
zai start --aa            # next start shows "Unpaired"
```

### Add a new InstanceDefinition

Just create it normally in the existing Instances page. The InstanceSupervisor emits `instance.changed {state: 'running', port}`, the AA runtime registry auto-registers it as a new runtime_instance. Mobile AA app sees it within a few seconds.

No restart needed.

### Disable AA without losing config

Stop zai and restart without `--aa`. The config file stays at `~/.zai/aa/config.json`. Restart with `--aa` later and it reconnects.

To **permanently disable and forget**, delete the file:
```bash
rm ~/.zai/aa/config.json
```

---

## Troubleshooting

### "AA 桥未启用" badge after I added `--aa`

Possible causes:

1. **Token hot-reload didn't take.** Stop zai (Ctrl+C) and restart `zai start --aa` — the flag is read at process start, not at runtime.
2. **CLI flag typo.** Check with `zai start --help | grep aa` — should show `--aa  Enable Agents Anywhere`.

### "Reconnecting (attempt N)" stuck at large N

AA server unreachable or auth failing repeatedly. Check:

```bash
# 1. Network reachability
curl -v https://web.agents-anywhere.com/api/v2/health

# 2. Token validity — re-paste a fresh cxt_xxx
#    Settings → AA 桥 → 取消 → 启动配对 → re-pair

# 3. Server-side rate-limit — wait 5 minutes, the backoff caps at 30s.
#    AA server enforces per-connector rate limits; sustained 503 → check
#    server logs at https://web.agents-anywhere.com (admin only)
```

The AASettings page shows the `lastError` field with the most recent failure reason — paste that into a bug report if needed.

### Sessions not appearing in mobile app

1. **Check the AASettings status** — must be `Connected`, not `Reconnecting`.
2. **Check the runtime registry** — Settings shows the connector info but not per-runtime. To inspect:
   ```bash
   cat ~/.zai/aa/runtime-map.json  # should list each InstanceDefinition
   ```
3. **Check the session map**:
   ```bash
   ls ~/.zai/aa/session-map-*.json  # one per child port
   ```
   If files are empty or stale, sessions may have been created before `--aa` was set. They reappear on next session create.
4. **Check the event adapter**: events only flow when the child zai is started with `--aa` too. The supervisor auto-forwards the flag from root. Verify:
   ```bash
   ps aux | grep "zai start" | grep -- --aa  # root + children should all have --aa
   ```

### Mobile app shows "disconnected" but zai says connected

This means AA server sees the connector offline. Causes:

1. **zai process actually crashed.** Check `ps aux | grep zai`.
2. **Heartbeat missing.** AA server expects `connector.heartbeat` every 30s. If zai's WS is wedged but appears connected, restart zai.
3. **Server-side issue.** Open https://web.agents-anywhere.com and check the dashboard.

### Outbox file growing too large

`~/.zai/aa/outbox-{port}.jsonl` queues events when WS is disconnected. If zai has been offline for a long time and the outbox exceeds `ZAI_AA_OUTBOX_MAX_MB` (default 50MB), the oldest entries are dropped.

Inspect:
```bash
ls -lh ~/.zai/aa/outbox-*.jsonl
```

Force a flush by reconnecting zai to AA (restart). If the buffer is permanently growing, AA server is unreachable and you should fix that first.

### Token leaked / need to rotate

```bash
# Revoke the old connector (server side):
#   AA Web → 我的设备 → revoke on the zai connector

# Drop the saved config:
rm ~/.zai/aa/config.json

# Restart and re-pair:
zai start --aa
# Settings → AA 桥 → 启动配对 → paste new cxt_xxx
```

---

## File map

```
~/.zai/aa/
├── config.json                Paired connector credentials (mode 0600).
│                              Delete to force re-pairing.
├── pairing-state.json         In-flight pairing (8-digit code). Cleared on success.
├── runtime-map.json           { childPort → aaRuntimeId } for all running instances.
├── session-map-{port}.json    { zaiSessionId → aaSessionId } per child port.
└── outbox-{port}.jsonl        Buffered AA notifications when WS disconnected.

~/.agents-anywhere/connector-runtime.json    (AA Desktop's own; not zai's — read-only reference)
```

zai **does not** write to `~/.agents-anywhere/`. zai pairs via AA Web and stores its own token in `~/.zai/aa/config.json` — completely independent from AA Desktop's credentials.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ZAI_AA_ENABLED` | unset | Set to `1` by `--aa`. Read by `isAaEnabled()` at runtime. |
| `ZAI_AA_OUTBOX_MAX_MB` | 50 | Per-port outbox size cap; oldest entries dropped beyond. |

The token (`cxt_xxx`) is **never** an env var — it's stored in `~/.zai/aa/config.json` (mode 0600) and read on each AA WS connect.

---

## Telemetry / health checks

`GET /api/aa/status` (with `X-Zai-Token`):

```json
{
  "status": "connected",
  "config": {
    "serverUrl": "https://web.agents-anywhere.com",
    "connectorId": "conn_xxxxxxxxxxxx",
    "connectorName": "zai on <serverUrl>",
    "pairedAt": "2026-09-27T...",
    "deviceOs": "macos",
    "tokenPresent": true
  },
  "connection": {
    "lastConnectedAt": "2026-09-27T...",
    "lastDisconnectedAt": null,
    "lastError": null,
    "reconnectAttempts": 0
  }
}
```

Use this for monitoring dashboards — the `status` field + `reconnectAttempts` give you everything you need.

---

## When to escalate

Open a bug at https://github.com/anywhere-labs/Agents-Anywhere/issues if:

- `status: "connected"` on zai but mobile app still shows "disconnected" for >5 minutes
- `reconnectAttempts > 10` for >10 minutes (server-side rate limit likely hit)
- Outbox file keeps growing despite `reconnectAttempts` incrementing (events never reaching AA)
- Any pairing flow returns 4xx other than `pairing_in_progress` (409)
