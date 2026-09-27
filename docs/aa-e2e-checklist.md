# Agents Anywhere (AA) Integration — E2E Test Checklist

> Manual test plan for verifying the full end-to-end zai ↔ AA ↔ mobile flow.
> Run after every release candidate of the AA integration.
>
> Pair with the [ops runbook](./aa-ops-runbook.md) when troubleshooting.

## Prerequisites

- [ ] A Mac (or Linux) with zai installed (`pnpm install` then `pnpm build`)
- [ ] Node.js 20+ available
- [ ] An Agents Anywhere account on https://web.agents-anywhere.com
- [ ] AA official mobile app installed (TestFlight iOS or Android APK)
- [ ] One or more InstanceDefinitions configured in zai (Settings → 实例管理)
- [ ] Network connectivity from test machine to `https://web.agents-anywhere.com`

## Setup

```bash
# 1. Make sure zai builds clean.
cd /path/to/opencc-web/packages/zai
pnpm install
pnpm typecheck
pnpm test test/aaClient/ test/web/AASettings.test.tsx test/web/aaApi.test.ts

# 2. Start zai with AA enabled.
zai start --aa

# Expected in terminal:
#   [aa.client] connected to https://web.agents-anywhere.com as conn_xxx
```

If you see `[aa.client] ZAI_AA_ENABLED=1 but no AA config found` → proceed to step 3 (first-time pairing).

---

## 1. First-time pairing

- [ ] **1.1** Open zai in browser → Settings → AA 桥 tab
- [ ] **1.2** Status badge shows **"Not paired"** (yellow)
- [ ] **1.3** Click **启动配对**
- [ ] **1.4** 8-digit code appears in large font with copy button
- [ ] **1.5** Note the code; click the copy button → see "已复制配对码" toast
- [ ] **1.6** Open https://web.agents-anywhere.com in another browser tab
- [ ] **1.7** 我的设备 → 添加设备 → "zai" connector type
- [ ] **1.8** Paste the 8-digit code in AA Web's pairing dialog
- [ ] **1.9** AA Web displays a `cxt_xxx` token (one-time visible)
- [ ] **1.10** Back in zai Settings → AA 桥 → click **我已输入,立即检查**
- [ ] **1.11** Status flips to **"Connected"** (green)
- [ ] **1.12** Connector 信息 card shows serverUrl, connectorId, pairedAt
- [ ] **1.13** Token is NOT shown anywhere in the UI (redaction check)

✅ If all 13 sub-checks pass: pairing is wired correctly.

---

## 2. Multi-runtime visibility

After pairing, verify each InstanceDefinition shows up in mobile AA app.

- [ ] **2.1** zai has at least 1 running InstanceDefinition (port 9201+)
- [ ] **2.2** Open AA official mobile app → 我的设备
- [ ] **2.3** Find zai connector (named whatever you set in step 1.9)
- [ ] **2.4** Tap into it → see list of runtime instances
- [ ] **2.5** Each InstanceDefinition appears with its `name` (e.g. "Project A")
- [ ] **2.6** Tap a runtime → empty sessions list (none created yet — expected)
- [ ] **2.7** Create a 2nd InstanceDefinition in zai (different cwd, port 9202)
- [ ] **2.8** Within ~5 seconds, it appears in mobile AA app
- [ ] **2.9** Stop the 2nd InstanceDefinition in zai
- [ ] **2.10** Within ~10 seconds, it disappears from mobile AA app

✅ If all 10 pass: runtime registry correctly hooks InstanceSupervisor.

---

## 3. Session creation + visibility

- [ ] **3.1** In zai, send a message to a session in InstanceDefinition A
- [ ] **3.2** Open mobile AA app → tap zai → tap "Project A" runtime
- [ ] **3.3** New session appears in the session list within 5 seconds
- [ ] **3.4** Session shows correct cwd, title
- [ ] **3.5** Tap session → empty timeline (timeline item mapping is partial in this release — expected)
- [ ] **3.6** Send another message in same session
- [ ] **3.7** Verify the session.updated event is reflected in mobile (status changes to running)

✅ Sessions are visible. Timeline item mapping is intentionally limited (see T6 limitations).

---

## 4. Approval flow (mobile → zai)

- [ ] **4.1** In zai, trigger an approval (e.g. ask AI to edit a file → permission prompt)
- [ ] **4.2** In zai terminal: see `[aa.eventAdapter] notice.upserted` log
- [ ] **4.3** Mobile AA app shows the approval notice
- [ ] **4.4** Tap approve in mobile
- [ ] **4.5** zai's approveRegistry receives the approval (check terminal: `[aa.reverseDispatch] handleApprove`)
- [ ] **4.6** zai's edit proceeds
- [ ] **4.7** Same for deny — verify approve/reject routes work
- [ ] **4.8** Same for AskUserQuestion — verify answer route works

✅ Approval flow works mobile → zai.

---

## 5. Send message from mobile

- [ ] **5.1** In mobile AA app, tap into an existing session
- [ ] **5.2** Type a message, tap send
- [ ] **5.3** zai receives the message (terminal: `[aa.reverseDispatch] handleSendMessage`)
- [ ] **5.4** The session becomes busy (turn starts)
- [ ] **5.5** zai's response appears
- [ ] **5.6** Test steer — mid-turn, send another message
- [ ] **5.7** The current turn is interrupted and the new message takes over
- [ ] **5.8** Test interrupt — tap "stop" mid-turn
- [ ] **5.9** zai's turn aborts cleanly (no crash)

✅ Reverse direction works.

---

## 6. Disconnect / reconnect

- [ ] **6.1** While zai is connected, simulate network drop:
  ```bash
  # If on macOS with Little Snitch or similar:
  # Block https://web.agents-anywhere.com for 30s
  ```
- [ ] **6.2** Status flips to **"Reconnecting"** with attempt counter incrementing
- [ ] **6.3** Outbox file `~/.zai/aa/outbox-{port}.jsonl` starts accumulating
- [ ] **6.4** Restore network
- [ ] **6.5** Status flips back to **"Connected"**
- [ ] **6.6** Outbox file is cleared (drained to AA server)
- [ ] **6.7** Mobile AA app is in sync (no missed events)

✅ Offline buffer + reconnect work.

---

## 7. Restart zai

- [ ] **7.1** Stop zai (Ctrl+C)
- [ ] **7.2** Verify graceful shutdown: terminal shows `[aa.client] stopping`
- [ ] **7.3** Restart: `zai start --aa`
- [ ] **7.4** Within 5 seconds, status is back to **"Connected"** (token cached)
- [ ] **7.5** Mobile app sees zai re-online (without needing to re-pair)

✅ Restart preserves pairing.

---

## 8. Multi-machine isolation

This validates the AA server's partition by `connector_id`.

- [ ] **8.1** On a SECOND machine (or VM), install + pair zai as a separate connector
- [ ] **8.2** AA Web now shows TWO zai connectors
- [ ] **8.3** Sessions from machine A only appear under machine A's connector
- [ ] **8.4** Sessions from machine B only appear under machine B's connector
- [ ] **8.5** Mobile app sees all of them, clearly labeled

✅ Server-side isolation correct.

---

## 9. Disabled state (no `--aa`)

- [ ] **9.1** Stop zai
- [ ] **9.2** Start without `--aa`: `zai start`
- [ ] **9.3** Settings → AA 桥 tab → status is **"Disabled"**
- [ ] **9.4** Alert shows: "zai 当前进程以不带 --aa 的方式启动..."
- [ ] **9.5** `GET /api/aa/status` returns `{"status": "disabled"}`
- [ ] **9.6** `POST /api/aa/pairing/start` returns 503 with `aa_disabled`
- [ ] **9.7** No `[aa.client]` lines in terminal
- [ ] **9.8** Stop, restart with `--aa`, verify it comes back

✅ Opt-in flag works as designed.

---

## 10. Security checks

- [ ] **10.1** `cat ~/.zai/aa/config.json` → file exists, mode 0600
- [ ] **10.2** Inspect `GET /api/aa/config` response in browser devtools → token field is absent
- [ ] **10.3** Inspect `GET /api/aa/status` response → token field is absent
- [ ] **10.4** Inspect AASettings page in browser → no cxt_xxx visible anywhere
- [ ] **10.5** Tail terminal during pairing → no token logged (only pairing code + connector name)
- [ ] **10.6** `cat ~/.zai/aa/outbox-*.jsonl` → no token in payload content
- [ ] **10.7** Revoke token via AA Web → Settings → AA 桥 → status flips to errored
- [ ] **10.8** `~/.agents-anywhere/connector-runtime.json` is unchanged after zai starts (zai doesn't read it)

✅ Token security verified.

---

## 11. Resource cleanup

- [ ] **11.1** `ls ~/.zai/aa/` → expect: config.json, pairing-state.json (transient), runtime-map.json, session-map-{ports}.json, outbox-{ports}.jsonl
- [ ] **11.2** Delete an InstanceDefinition in zai → corresponding `session-map-{port}.json` should eventually clean up (next reconcile tick)
- [ ] **11.3** Stop zai → all in-memory state cleaned (no orphan timers)
- [ ] **11.4** `ps aux | grep "zai start"` → all child zai processes have `--aa` (auto-forwarded by supervisor)

✅ Cleanup correct.

---

## 12. Failure injection

Test the recovery paths:

- [ ] **12.1** Invalid server URL at pairing → "请输入有效 URL" validation
- [ ] **12.2** Pair twice in quick succession → second attempt gets 409 with existing state
- [ ] **12.3** Cancel an in-flight pairing → state file cleared, UI returns to "Not paired"
- [ ] **12.4** Pair code expired (15min default) → status flips to "expired"
- [ ] **12.5** Restart zai mid-pairing → resume from same state on next start
- [ ] **12.6** Server returns 500 on auth → reconnect with exponential backoff

✅ Error paths handle gracefully.

---

## Automation helper: `scripts/aa-e2e-smoke.sh`

A semi-automated wiring check (does not exercise the real cloud — verify manually after):

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")/../packages/zai"

echo "[1/5] typecheck..."
pnpm typecheck

echo "[2/5] unit tests (AA modules)..."
pnpm vitest run test/aaClient/ test/web/AASettings.test.tsx test/web/aaApi.test.ts

echo "[3/5] verifying paths module exports..."
node --input-type=module -e "
  const p = await import('./dist/server/services/paths.js');
  const expected = ['aaDir','aaConfigPath','aaPairingStatePath','aaRuntimeMapPath','aaSessionMapPath','aaOutboxPath','ensureAaDir'];
  for (const fn of expected) {
    if (typeof p[fn] !== 'function') throw new Error('missing: ' + fn);
  }
  console.log('  paths:', expected.join(', '));
"

echo "[4/5] verifying CLI flag wiring..."
grep -q "options.aa" src/cli/index.ts && echo "  cli: --aa option registered" || (echo "  cli: MISSING --aa option" && exit 1)

echo "[5/5] verifying init order..."
grep -q "initRuntimeRegistry(conn)" src/server/services/aaClient/init.ts && echo "  init: runtime registry initialized" || exit 1
grep -q "initSessionMap()" src/server/services/aaClient/init.ts && echo "  init: session map initialized" || exit 1
grep -q "initEventAdapter(conn)" src/server/services/aaClient/init.ts && echo "  init: event adapter initialized" || exit 1
grep -q "ReverseDispatch" src/server/services/aaClient/init.ts && echo "  init: reverse dispatch installed" || exit 1

echo ""
echo "✅ All automated checks pass. Run manual E2E (sections 1-12) for full validation."
```

---

## Sign-off checklist

Run this checklist every release. Tick every box before merging:

- [ ] Automated smoke (`scripts/aa-e2e-smoke.sh`) passes
- [ ] Sections 1-3 pass (pairing + runtime visibility + session creation)
- [ ] Sections 4-5 pass (approval flow + send from mobile)
- [ ] Section 6 passes (disconnect / reconnect)
- [ ] Section 7 passes (restart preserves pairing)
- [ ] Section 9 passes (disabled state with `--aa` absent)
- [ ] Section 10 passes (token security)

Sections 8, 11, 12 are recommended but not blocking.

---

## Reporting bugs

When filing an AA integration bug, include:

1. Output of `GET /api/aa/status` (token fields excluded automatically)
2. Last 50 lines of zai terminal (look for `[aa.client]` / `[aa.runtimeRegistry]` / `[aa.eventAdapter]` / `[aa.reverseDispatch]` prefixes)
3. AA Web browser console (DevTools → Console, Network tabs)
4. Mobile app version + OS version
5. Steps to reproduce

Open issues at https://github.com/anywhere-labs/Agents-Anywhere/issues with `[opencc-zai]` prefix.
