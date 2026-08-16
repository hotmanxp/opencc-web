# zai permissions 直调 opencc-src 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **状态：已过期(2026-08-16)**
> 本文档提到的 `package.json` exports subpath(`@zn-ai/zn-agent-core/<subpath>`)已全部废除,运行时与 types 都从主入口 `@zn-ai/zn-agent-core` 导出(参见 plan `~/.zai/plans/glowing-toasting-elephant.md`)。本文档保留作为历史记录,不再代表当前实现。

**Goal:** 把 zai 服务对 `EXTERNAL_PERMISSION_MODES` 的导入从 `@zn-ai/zn-agent-core` 顶层改为直调 `@zn-ai/zn-agent-core/opencc-src/permissions`(走 opencc-src 而非 compat shim),`UserFacingPermissionMode` 仍走 compat(zai 专属别名)。

**Architecture:** 在 `zn-agent-core` 暴露 `opencc-src/permissions` 子路径,通过 esbuild 单文件编译 `src/opencc-src/types/permissions.ts`(不打 bundle,types 全部擦除)产出 `dist/opencc-src/types/permissions.js`。zai 改 2 处 import + 4 处 mock + 新增 1 个静态扫描回归测试。

**Tech Stack:** esbuild(单文件编译)、vitest(回归测试)、tsc -b(zn-agent-core 已用)、pnpm workspace。

## Global Constraints

- Node 版本:Node 22+(项目 `dev:node` 依赖)
- pnpm workspace 单仓多包,改任何 `@zn-ai/zn-agent-core` 包内容必须重 build 后 zai 才能解析
- 不删 `packages/zn-agent-core/src/compat/permissions.ts` 与 `compat/permissionMode.ts`(本轮不删,留作参考)
- `compat/permissions.ts` 注释原说明:"opencc-src 拖入 React/JSX/opentelemetry/lodash-es",所以本轮**不**通过 tsc 整编 opencc-src,只走 esbuild 单文件 + `bundle:false`
- 测试 mock 改路径时只改 mock target,不动 mock 内容(5 项 const 数组不变)
- **UI / 权限短路规则**:源代码里有 UI 调用 / 权限判断需要 UI 交互的(例如 opencc 的 `Tool.checkPermissions` 返回 `'ask'` 弹权限对话框、`runPreToolUseHooks` 注入 `case 'stop'` 等),直接改原代码跳过,返回 `'allow'` / `true` 等允许值。**不**留 stub、**不**抛 error,真 WEB UI 配置后阶段再补。已经这么做的:`forceAllowCheckPermissions`(`compat/tools/opencc/builtin.ts`)、`__zaiSkipPreToolUseHooks` flag(per history 2026-07-31,绕过 zai runtime 下 vendor PreToolUse hooks 的 `stop` 类型 yield)
- 本轮 `opencc-src/types/permissions.ts` 是纯 const + type 文件,不含 UI/权限交互,所以本规则不直接落地到本任务的代码改动;但适用于后续轮次(B 档: MCP pool / plugins / hook runner 委托时遇到 UI 调用就要短路)
- **依赖补齐规则**:实施时若发现 package 缺依赖,直接 `pnpm add` 或 `pnpm add -D` 补齐,不要 stub、不要 mock 假装通过。本 plan 预检 `packages/zn-agent-core/package.json`:`esbuild 0.28.1`(devDep,Task 1 用)、`@anthropic-ai/sdk ^0.94.0`(dep,types/permissions.ts 类型导入)、`vitest ^2.1.0`(devDep,Task 2/4 测试)全部到位,无需新增

---

## File Structure

### Created

- `packages/zai/test/server/permission-import-path.test.ts` — 静态扫描 zai 源文件,断言 `EXTERNAL_PERMISSION_MODES` 走 `opencc-src/permissions` 子路径,`UserFacingPermissionMode` 仍走 compat

### Modified

- `packages/zn-agent-core/package.json` — `exports` 加 `"./opencc-src/permissions": "./dist/opencc-src/types/permissions.js"`
- `packages/zn-agent-core/scripts/bundle-opencc.ts` — 末尾追加 esbuild 单文件编译
- `packages/zai/src/server/routes/agent.ts:20` — 拆成两个 import
- `packages/zai/src/server/services/permissionMode.ts:4` — 拆成两个 import
- `packages/zai/test/server/agent.test.ts:82-84` — mock 路径
- `packages/zai/test/server/routes-agent.test.ts:59-61` — mock 路径
- `packages/zai/test/server/agent-abort.test.ts:64` — mock 路径
- `packages/zai/test/integration/agent.test.ts:48` — mock 路径

---

## Task 1: Build pipeline — esbuild 单文件编译 + 子路径 export

**Files:**
- Modify: `packages/zn-agent-core/scripts/bundle-opencc.ts`(末尾追加 esbuild 调用)
- Modify: `packages/zn-agent-core/package.json`(`exports` 字段加一行)

**Interfaces:**
- Consumes: 已存在的 `esbuild`、`ROOT`、`OUT_DIR` 符号(`scripts/bundle-opencc.ts` 顶部)
- Produces: `packages/zn-agent-core/dist/opencc-src/types/permissions.js` + 子路径 export 解析

- [ ] **Step 1: 在 `bundle-opencc.ts` 末尾追加 esbuild 调用**

打开 `packages/zn-agent-core/scripts/bundle-opencc.ts`,在文件末尾(在 `build()` 之后、`await context.rebuild()` 模式之前或最后一行)追加以下代码块。**注意:** 保留原有 bundle 逻辑不变,只在末尾加新调用。

```ts
// ── Single-file esbuild for opencc-src pure type/const files ──
// Some compat shims are verbatim ports of opencc-src modules
// (e.g. permissions.ts). Compile just the single file (no bundle,
// no transitive imports) so we don't drag React/JSX/opentelemetry/
// lodash-es from opencc's vendored tree.
const PERMISSIONS_ENTRY = join(ROOT, 'src', 'opencc-src', 'types', 'permissions.ts')
const PERMISSIONS_OUT = join(ROOT, 'dist', 'opencc-src', 'types', 'permissions.js')

await esbuild.build({
  entryPoints: [PERMISSIONS_ENTRY],
  bundle: false,
  format: 'esm',
  outfile: PERMISSIONS_OUT,
  platform: 'node',
  target: 'node22',
})

console.log(`[bundle-opencc] permissions: ${PERMISSIONS_OUT}`)
```

- [ ] **Step 2: 跑 build 验证产物**

Run:
```bash
pnpm --filter @zn-ai/zn-agent-core build 2>&1 | tail -20
ls -la packages/zn-agent-core/dist/opencc-src/types/permissions.js
```

Expected:
- build 退出码 0
- `permissions.js` 文件存在
- 体积 < 5KB(纯 const + type,实际应 < 500B)
- `console.log` 输出 `[bundle-opencc] permissions: ...`

- [ ] **Step 3: 加 `package.json` 的 exports 入口**

修改 `packages/zn-agent-core/package.json`,在 `exports` 对象内加一行(放在 `"./opencc-core"` 后,保持字母序):

```json
    "./opencc-core": "./dist/opencc-core.mjs",
+   "./opencc-src/permissions": "./dist/opencc-src/types/permissions.js",
```

- [ ] **Step 4: 重 build + 验证 export 解析**

Run:
```bash
pnpm --filter @zn-ai/zn-agent-core build 2>&1 | tail -10
node -e "import('@zn-ai/zn-agent-core/opencc-src/permissions').then(m => console.log('EXTERNAL:', m.EXTERNAL_PERMISSION_MODES))"
```

Expected:
- build 退出码 0
- node 输出 `EXTERNAL: [ 'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan' ]`
- 5 项数组,顺序与 opencc-src 一致

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/scripts/bundle-opencc.ts packages/zn-agent-core/package.json packages/zn-agent-core/dist/opencc-src/types/permissions.js
git commit -m "$(cat <<'EOF'
feat(zn-agent-core): expose opencc-src/permissions subpath via esbuild

Single-file esbuild compile of src/opencc-src/types/permissions.ts
(no bundle, types erased) so zai can import EXTERNAL_PERMISSION_MODES
directly without going through the compat shim layer.

Compilation is intentionally narrow — bundle=false avoids pulling
React/JSX/opentelemetry/lodash-es transitive deps that motivated the
compat shim originally.
EOF
)"
```

---

## Task 2: 添加静态扫描回归测试(TDD red)

**Files:**
- Create: `packages/zai/test/server/permission-import-path.test.ts`

**Interfaces:**
- Consumes: 静态读 `packages/zai/src/server/routes/agent.ts` 与 `packages/zai/src/server/services/permissionMode.ts`
- Produces: 4 个 vitest `it()` 断言,扫描 import 语句

- [ ] **Step 1: 写测试文件**

创建 `packages/zai/test/server/permission-import-path.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_TS = readFileSync(
  join(__dirname, '../../src/server/routes/agent.ts'),
  'utf-8',
)
const PERMISSION_MODE_TS = readFileSync(
  join(__dirname, '../../src/server/services/permissionMode.ts'),
  'utf-8',
)

// Strip the new opencc-src import so the negative assertion below
// doesn't false-positive on the new path. We want to detect any
// re-import from package root, not the new subpath.
function stripOpenccSrcImport(src: string): string {
  return src.replace(
    /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]\s*;?/g,
    '',
  )
}

describe('permissions import path regression', () => {
  it('routes/agent.ts imports EXTERNAL_PERMISSION_MODES from opencc-src subpath', () => {
    expect(AGENT_TS).toMatch(
      /from\s+['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]/,
    )
  })

  it('routes/agent.ts imports UserFacingPermissionMode from compat', () => {
    expect(AGENT_TS).toMatch(
      /import\s+type\s*\{[^}]*UserFacingPermissionMode[^}]*\}\s+from\s+['"]@zn-ai\/zn-agent-core\/compat\/permissions['"]/,
    )
  })

  it('routes/agent.ts does NOT import EXTERNAL_PERMISSION_MODES from package root', () => {
    const stripped = stripOpenccSrcImport(AGENT_TS)
    const m = stripped.match(
      /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core['"]/,
    )
    expect(m).toBeNull()
  })

  it('services/permissionMode.ts imports EXTERNAL_PERMISSION_MODES from opencc-src subpath', () => {
    expect(PERMISSION_MODE_TS).toMatch(
      /from\s+['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]/,
    )
  })

  it('services/permissionMode.ts imports UserFacingPermissionMode from compat', () => {
    expect(PERMISSION_MODE_TS).toMatch(
      /import\s+type\s*\{[^}]*UserFacingPermissionMode[^}]*\}\s+from\s+['"]@zn-ai\/zn-agent-core\/compat\/permissions['"]/,
    )
  })

  it('services/permissionMode.ts does NOT import EXTERNAL_PERMISSION_MODES from package root', () => {
    const stripped = stripOpenccSrcImport(PERMISSION_MODE_TS)
    const m = stripped.match(
      /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core['"]/,
    )
    expect(m).toBeNull()
  })
})
```

(共 6 个断言,spec 里只列了 4 个 — 这里把 permissionMode.ts 的两个 case 也补齐,完整覆盖两个文件)

- [ ] **Step 2: 跑测试,确认 RED(全 fail)**

Run:
```bash
cd packages/zai && pnpm vitest run test/server/permission-import-path.test.ts 2>&1 | tail -40
```

Expected: 6 个测试全 fail(因为 zai 当前仍走 `@zn-ai/zn-agent-core` 顶层)。失败信息含 `expected '...' to match ...`。

- [ ] **Step 3: Commit(red 状态)**

```bash
git add packages/zai/test/server/permission-import-path.test.ts
git commit -m "$(cat <<'EOF'
test(zai): add static-scan regression for permissions import path

Guards against future PRs reverting the EXTERNAL_PERMISSION_MODES
import back to the package root. Test reads zai source files and
asserts imports target the opencc-src subpath (for the const) and
the compat shim (for the zai-only UserFacingPermissionMode alias).
EOF
)"
```

---

## Task 3: 改 zai 调用方 import

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts:20`(单行替换为两行)
- Modify: `packages/zai/src/server/services/permissionMode.ts:4`(单行替换为两行)

**Interfaces:**
- Consumes: `@zn-ai/zn-agent-core/opencc-src/permissions`(Task 1 暴露)
- Consumes: `@zn-ai/zn-agent-core/compat/permissions`(已存在)
- Produces: zai 解析 `EXTERNAL_PERMISSION_MODES` 走 opencc-src,`UserFacingPermissionMode` 走 compat

- [ ] **Step 1: 改 `routes/agent.ts`**

Edit `packages/zai/src/server/routes/agent.ts:20`:

```diff
-import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from "@zn-ai/zn-agent-core";
+import { EXTERNAL_PERMISSION_MODES } from "@zn-ai/zn-agent-core/opencc-src/permissions";
+import type { UserFacingPermissionMode } from "@zn-ai/zn-agent-core/compat/permissions";
```

- [ ] **Step 2: 改 `services/permissionMode.ts`**

Edit `packages/zai/src/server/services/permissionMode.ts:4`:

```diff
-import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from '@zn-ai/zn-agent-core'
+import { EXTERNAL_PERMISSION_MODES } from '@zn-ai/zn-agent-core/opencc-src/permissions'
+import type { UserFacingPermissionMode } from "@zn-ai/zn-agent-core/compat/permissions";
```

- [ ] **Step 3: 跑 zai typecheck**

Run:
```bash
pnpm --filter @zn-ai/zai typecheck 2>&1 | tail -20
```

Expected: 退出码 0,无 TS 报错。

- [ ] **Step 4: 跑回归测试,确认 GREEN**

Run:
```bash
cd packages/zai && pnpm vitest run test/server/permission-import-path.test.ts 2>&1 | tail -20
```

Expected: 6 个测试全 pass。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/agent.ts packages/zai/src/server/services/permissionMode.ts
git commit -m "$(cat <<'EOF'
refactor(zai): import EXTERNAL_PERMISSION_MODES from opencc-src subpath

Splits the dual-symbol import into two:
- EXTERNAL_PERMISSION_MODES comes from opencc-src/permissions (the
  actual source of truth in vendored opencc)
- UserFacingPermissionMode stays on compat (zai-only alias opencc
  doesn't expose)

Compat shim files remain untouched as reference. Subsequent PRs
cannot revert this without tripping the static-scan regression.
EOF
)"
```

---

## Task 4: 更新 4 个测试 mock 路径

**Files:**
- Modify: `packages/zai/test/server/agent.test.ts:82-84`
- Modify: `packages/zai/test/server/routes-agent.test.ts:59-61`
- Modify: `packages/zai/test/server/agent-abort.test.ts:64`
- Modify: `packages/zai/test/integration/agent.test.ts:48`

**Interfaces:**
- Consumes: `vi.mock()` 的 module path 参数
- Produces: 4 个 mock 重定向到 `@zn-ai/zn-agent-core/opencc-src/permissions`,mock 内容(5 项 const 数组)不变

- [ ] **Step 1: 改 `agent.test.ts:82-84`**

Edit `packages/zai/test/server/agent.test.ts`,找到包含 `EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']` 的 `vi.mock` 块,把 mock target 从 `@zn-ai/zn-agent-core` 改成 `@zn-ai/zn-agent-core/opencc-src/permissions`。mock 内容(5 项数组)保持不变。

- [ ] **Step 2: 改 `routes-agent.test.ts:59-61`**

同上,改 mock target。

- [ ] **Step 3: 改 `agent-abort.test.ts:64`**

同上,改 mock target。

- [ ] **Step 4: 改 `integration/agent.test.ts:48`**

同上,改 mock target。

- [ ] **Step 5: 跑完整 zai 测试套件**

Run:
```bash
pnpm --filter @zn-ai/zai test 2>&1 | tail -40
```

Expected: 全绿,无 pre-existing 失败恶化。如果有失败,优先检查 mock target 是否正确改到 `opencc-src/permissions` 子路径。

- [ ] **Step 6: Commit**

```bash
git add packages/zai/test/server/agent.test.ts \
        packages/zai/test/server/routes-agent.test.ts \
        packages/zai/test/server/agent-abort.test.ts \
        packages/zai/test/integration/agent.test.ts
git commit -m "$(cat <<'EOF'
test(zai): point permission mocks at opencc-src subpath

Tests mock EXTERNAL_PERMISSION_MODES to control zod enum validation.
Now that zai imports from opencc-src subpath, mocks must intercept
that subpath to remain effective.
EOF
)"
```

---

## Task 5: 端到端冒烟验证

**Files:** 无新增/修改(可选:`packages/zn-agent-core/docs/api-gap-matrix.md` 更新一行)

**Interfaces:**
- Consumes: zai dev server + `POST /api/agent/prompt` 接口
- Produces: 验证 permissionMode schema 接受所有 5 种模式

- [ ] **Step 1: 启动 dev server**

Run:
```bash
pnpm --filter @zn-ai/zai dev
```

Expected: 服务监听 `http://localhost:端口`,无 import 报错,无 `Cannot find module '@zn-ai/zn-agent-core/opencc-src/permissions'` 错。

- [ ] **Step 2: curl 验证 `permissionMode: 'plan'`**

Run:
```bash
curl -X POST http://localhost:<port>/api/agent/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"hi","permissionMode":"plan"}'
```

Expected: 返回 200 + sessionId。验证 zod enum 在 'plan' 上没抛错。

- [ ] **Step 3: 验证无效模式被拒绝**

Run:
```bash
curl -X POST http://localhost:<port>/api/agent/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"hi","permissionMode":"unknown_mode"}'
```

Expected: 返回 400 + zod 校验错误,明确指出 `permissionMode` 不在合法集合内。证明 zod enum 引用的是 opencc-src 的 5 项数组。

- [ ] **Step 4: 检查日志**

Run:
```bash
ls -lt ~/.zai/logs/ | head -5
```

Expected: 无新增 error log。如果 dev server 期间有 import 失败会写到 stderr。

- [ ] **Step 5: 关闭 dev server**

按 Ctrl+C 关闭。如果用 background 进程,kill 对应 PID。

- [ ] **Step 6: (可选)更新 `api-gap-matrix.md`**

把 `docs/api-gap-matrix.md:16-17` 中 `EXTERNAL_PERMISSION_MODES` 的 status 从 "Identical const array / Same const / Re-export" 更新为 **"Direct subpath import (`opencc-src/permissions`) since 2026-08-01"**。方便后续读此文档的工程师知道已经迁移过。

如果改:
```bash
git add packages/zn-agent-core/docs/api-gap-matrix.md
git commit -m "docs(zn-agent-core): mark EXTERNAL_PERMISSION_MODES as migrated to subpath"
```

如果不改:不 commit,留待后续轮次。

---

## Self-Review

### 1. Spec coverage

| Spec 节 | 任务 |
|---|---|
| §1 暴露 opencc-src 子路径 | Task 1 |
| §2 单文件 esbuild 编译 | Task 1 |
| §3 zai 调用方改 import | Task 3 |
| §4 测试 mock 路径更新 | Task 4 |
| §5 新增回归测试 | Task 2 |
| 数据流 / 错误处理 / 回滚 | Task 5(冒烟)+ 文档内置(无需任务) |

无遗漏。

### 2. Placeholder scan

- 无 "TBD" / "TODO"
- 无 "implement later"
- 无 "Add appropriate error handling" 模糊措辞
- 测试代码完整给出,无 "Similar to Task N"
- 每步命令具体

### 3. Type consistency

- `EXTERNAL_PERMISSION_MODES` 在 spec / Task 1 esbuild 输出 / Task 2 测试 regex / Task 3 import / Task 4 mock 中命名一致
- `UserFacingPermissionMode` 在所有任务中命名一致
- 子路径字符串 `@zn-ai/zn-agent-core/opencc-src/permissions` 在所有任务中完全一致
- `stripOpenccSrcImport` 函数签名与调用方一致

### 4. 范围检查

单一功能,5 个任务各自交付独立可测量的产出。无子系统分解需要。

### 5. 风险点标注

- Task 4 Step 5 如果出现非 mock 失败的失败(比如其他不相关的 pre-existing failure),需要先单独确认是 pre-existing 还是引入的新失败。spec §回滚 R1/R2 路径已就绪
- Task 1 Step 4 的 `node -e` 在 Node 22+ 默认支持 ESM dynamic import,需 `package.json` `"type": "module"` — zn-agent-core 已确认是 module
- Task 5 冒烟步骤依赖用户在跑的端口;若端口被占,需要 `pnpm --filter @zn-ai/zai dev` 启动时指定 `--port`

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-01-compat-direct-opencc-src-permissions.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?