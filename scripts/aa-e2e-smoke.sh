#!/bin/bash
# AA integration automated wiring smoke check.
# Does NOT exercise the real cloud — verifies internal wiring (CLI flag,
# init order, route mount, module exports). For full E2E, follow
# docs/aa-e2e-checklist.md manually.

set -e
cd "$(dirname "$0")/../packages/zai"

echo "[1/6] typecheck..."
pnpm typecheck

echo "[2/6] unit tests (AA modules)..."
pnpm vitest run test/aaClient/ test/web/AASettings.test.tsx test/web/aaApi.test.ts

echo "[3/6] verifying paths module exports..."
node --input-type=module -e "
  const p = await import('./dist/server/services/paths.js');
  const expected = ['aaDir','aaConfigPath','aaPairingStatePath','aaRuntimeMapPath','aaSessionMapPath','aaOutboxPath','ensureAaDir'];
  for (const fn of expected) {
    if (typeof p[fn] !== 'function') throw new Error('missing: ' + fn);
  }
  console.log('  paths:', expected.length, 'exports verified');
"

echo "[4/6] verifying CLI flag wiring..."
grep -q "options.aa" src/cli/index.ts && echo "  cli: --aa option registered" || (echo "  cli: MISSING --aa option" && exit 1)
grep -q "if (options.aa) childArgs.push" src/cli/start.ts && echo "  start.ts: --aa forwarded to supervisor child" || exit 1
grep -q "if (process.env.ZAI_AA_ENABLED" src/server/services/instanceSupervisor.ts && echo "  instanceSupervisor: --aa forwarded to child instances" || exit 1

echo "[5/6] verifying init order..."
grep -q "initRuntimeRegistry(conn)" src/server/services/aaClient/init.ts && echo "  init: runtime registry initialized" || exit 1
grep -q "initSessionMap()" src/server/services/aaClient/init.ts && echo "  init: session map initialized" || exit 1
grep -q "initEventAdapter(conn)" src/server/services/aaClient/init.ts && echo "  init: event adapter initialized" || exit 1
grep -q "initOfflineBuffer(conn" src/server/services/aaClient/init.ts && echo "  init: offline buffer initialized" || exit 1
grep -q "ReverseDispatch" src/server/services/aaClient/init.ts && echo "  init: reverse dispatch installed" || exit 1

echo "[6/6] verifying route mounts..."
grep -q "app.use('/api/aa', aaPairingRouter)" src/server/index.ts && echo "  routes: aaPairingRouter mounted" || exit 1
grep -q "app.use('/api/aa', aaStatusRouter)" src/server/index.ts && echo "  routes: aaStatusRouter mounted" || exit 1
grep -q "app.use('/api/internal', childEventRouter)" src/server/index.ts && echo "  routes: childEventRouter mounted" || exit 1
grep -q "app.use('/api/internal', pushActionRouter)" src/server/index.ts && echo "  routes: pushActionRouter mounted" || exit 1
grep -q "'AA 桥'" src/web/src/pages/Manage.tsx && echo "  web: AA tab registered in Manage" || exit 1

echo ""
echo "✅ All automated wiring checks pass."
echo "   Run docs/aa-e2e-checklist.md manually for full end-to-end validation."
