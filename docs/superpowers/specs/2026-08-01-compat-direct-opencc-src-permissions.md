# zai `permissions` 直调 `opencc-src` — 设计

日期: 2026-08-01
作者: brainstorming session with Ethan
状态: 设计稿,待评审

> **状态：已过期(2026-08-16)**
> 本设计提到的 `package.json` exports subpath(`@zn-ai/zn-agent-core/<subpath>`)已全部废除,运行时与 types 都从主入口 `@zn-ai/zn-agent-core` 导出(参见 plan `~/.zai/plans/glowing-toasting-elephant.md`)。本文档保留作为历史记录,不再代表当前实现。

## 背景

`packages/zn-agent-core/src/compat/permissions.ts` 是个 verbatim 移植,内容与 `packages/zn-agent-core/src/opencc-src/types/permissions.ts` 在 `EXTERNAL_PERMISSION_MODES` / `ExternalPermissionMode` 上逐字等价。`compat/permissionMode.ts` 仅一行 `export * from './permissions.js'`。

zai 服务有 2 个文件从这个 compat shim 拿权限相关符号:

- `packages/zai/src/server/routes/agent.ts:20` — `import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from "@zn-ai/zn-agent-core"`
- `packages/zai/src/server/services/permissionMode.ts:4` — `import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from '@zn-ai/zn-agent-core'`

`api-gap-matrix.md:16-20` 显式记录 `EXTERNAL_PERMISSION_MODES` 是 direct re-export 候选;`UserFacingPermissionMode` 是 zai 专属别名,opencc 不暴露。

## 目标

让 zai 服务**直接**从 opencc-src 取 `EXTERNAL_PERMISSION_MODES`,compat 文件仅保留作为参考(`UserFacingPermissionMode` 别名的载体)。

## 非目标

- 不删 `compat/permissions.ts` / `compat/permissionMode.ts` — 留作参考,本轮不动
- 不删 `compat/cwdStore.ts` 中的 `readTrailer()`
- 不清理 11 个 stale 文件头注释或 README 引用 — 留待后续轮次
- 不动 B 档(MCP pool / plugin runtime / hook runner 委托)
- 不动 C 档所有 compat 子树

## 设计

### 1. 暴露 opencc-src 子路径

`packages/zn-agent-core/package.json` 的 `exports` 字段加:

```json
"./opencc-src/permissions": "./dist/opencc-src/types/permissions.js"
```

子路径名取 `opencc-src/permissions` 而非 `opencc-src/types/permissions`,缩短调用方路径;opencc-src 子路径空间是新增的,留待后续轮次扩展。

### 2. 单文件 esbuild 编译

`packages/zn-agent-core/tsconfig.json:24` 当前 `"exclude": ["src/opencc-src"]` 把整个 opencc-src 排除在 tsc 之外。**不能用 C1a**(整编 opencc-src 会触发 React/JSX/opentelemetry/lodash-es 等传递依赖,这是当初建 compat shim 的根因)。

采用 C1c:在 `scripts/bundle-opencc.ts` 末尾加一段 esbuild 调用,只编 `src/opencc-src/types/permissions.ts` → `dist/opencc-src/types/permissions.js`。

```ts
// scripts/bundle-opencc.ts 末尾追加
const PERMISSIONS_ENTRY = join(ROOT, 'src', 'opencc-src', 'types', 'permissions.ts')
const PERMISSIONS_OUT = join(ROOT, 'dist', 'opencc-src', 'types', 'permissions.js')

await esbuild.build({
  entryPoints: [PERMISSIONS_ENTRY],
  bundle: false,            // 单文件,不打 bundle — types 全部擦除
  format: 'esm',
  outfile: PERMISSIONS_OUT,
  platform: 'node',
  target: 'node22',
})
```

理由:

- `opencc-src/types/permissions.ts` 只 `import type { ContentBlockParam } from '@anthropic-ai/sdk/...'`,类型擦除后无 runtime 依赖
- esbuild 单文件编译是 zn-agent-core build pipeline 已用的工具(`bundle-opencc.ts` 同脚本),不引入新依赖
- bundle=false 避免拖入任何传递依赖
- 目标 node22 与项目 Node 版本一致

### 3. zai 调用方改 import

```
packages/zai/src/server/routes/agent.ts:20
  - import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from "@zn-ai/zn-agent-core";
  + import { EXTERNAL_PERMISSION_MODES } from "@zn-ai/zn-agent-core/opencc-src/permissions";
  + import type { UserFacingPermissionMode } from "@zn-ai/zn-agent-core/compat/permissions";

packages/zai/src/server/services/permissionMode.ts:4
  - import { EXTERNAL_PERMISSION_MODES, type UserFacingPermissionMode } from '@zn-ai/zn-agent-core'
  + import { EXTERNAL_PERMISSION_MODES } from '@zn-ai/zn-agent-core/opencc-src/permissions'
  + import type { UserFacingPermissionMode } from "@zn-ai/zn-agent-core/compat/permissions";
```

`EXTERNAL_PERMISSION_MODES` 从 opencc-src 拿,`UserFacingPermissionMode` 仍是 zai 专属别名,从 compat 拿。

### 4. 测试 mock 路径更新

4 个 zai 测试 mock 了 `@zn-ai/zn-agent-core` 顶层并重写 `EXTERNAL_PERMISSION_MODES`:

- `test/server/agent.test.ts:82-84`
- `test/server/routes-agent.test.ts:59-61`
- `test/server/agent-abort.test.ts:64`
- `test/integration/agent.test.ts:48`

mock 路径改为 `vi.mock('@zn-ai/zn-agent-core/opencc-src/permissions', ...)`。mock 内容(5 项 const 数组)不变。

### 5. 新增回归测试

`packages/zai/test/server/permission-import-path.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const agentTs = readFileSync(
  join(__dirname, '../../src/server/routes/agent.ts'), 'utf-8',
)
const permissionModeTs = readFileSync(
  join(__dirname, '../../src/server/services/permissionMode.ts'), 'utf-8',
)

it('routes/agent.ts imports EXTERNAL_PERMISSION_MODES from opencc-src subpath', () => {
  expect(agentTs).toMatch(
    /from\s+['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]/,
  )
})

it('routes/agent.ts imports UserFacingPermissionMode from compat', () => {
  expect(agentTs).toMatch(
    /import\s+type\s*\{[^}]*UserFacingPermissionMode[^}]*\}\s+from\s+['"]@zn-ai\/zn-agent-core\/compat\/permissions['"]/,
  )
})

it('routes/agent.ts no longer imports EXTERNAL_PERMISSION_MODES from package root', () => {
  // Exclude the new subpath import first to avoid false positives
  const stripped = agentTs.replace(
    /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core\/opencc-src\/permissions['"]\s*;?/g,
    '',
  )
  const m = stripped.match(
    /import\s*\{[^}]*EXTERNAL_PERMISSION_MODES[^}]*\}\s*from\s*['"]@zn-ai\/zn-agent-core['"]/,
  )
  expect(m).toBeNull()
})

// permissionMode.ts 同上两个 case
```

目的:阻止后续 PR 把 import 改回 `@zn-ai/zn-agent-core` 顶层。文件存在即防线,无需 runtime 验证。

## 数据流

```
zai runtime
  │
  ├─ routes/agent.ts:20
  │   ├─ EXTERNAL_PERMISSION_MODES → @zn-ai/zn-agent-core/opencc-src/permissions
  │   └─ type UserFacingPermissionMode → @zn-ai/zn-agent-core/compat/permissions
  │
  └─ services/permissionMode.ts:4
      ├─ EXTERNAL_PERMISSION_MODES → @zn-ai/zn-agent-core/opencc-src/permissions
      └─ type UserFacingPermissionMode → @zn-ai/zn-agent-core/compat/permissions

build pipeline (pnpm --filter @zn-ai/zn-agent-core build)
  │
  ├─ bundle-opencc.ts:
  │   ├─ esbuild src/opencc-src/query.ts → dist/opencc-core.mjs (现有)
  │   └─ esbuild src/opencc-src/types/permissions.ts → dist/opencc-src/types/permissions.js (新增)
  │
  └─ tsc -b: 走 tsconfig.json, src/opencc-src 仍 exclude,兼容文件照常编
```

## 错误处理

| 失败模式 | 表现 | 兜底 |
|---|---|---|
| `opencc-src/types/permissions.ts` 引入非类型 runtime import | esbuild 报"Cannot resolve X" | 已检查文件内容,仅 `import type ContentBlockParam`,无 runtime import |
| esbuild 产物体积过大 | bundle > 5KB | 实际应 < 500B(纯 const + type),警告阈值 5KB |
| dist/opencc-src/types/ 目录不存在 | esbuild 自动 mkdir | 无需手动建 |
| zai 解析子路径失败 | `ERR_MODULE_NOT_FOUND` | 跑 `pnpm install` 重指 symlink |
| build 顺序错误,新 export 未生成 | zai 解析失败 | bundle-opencc 在 tsc -b 之前完成,且 dist 写入原子重命名 |

## 测试

### 单元 / 集成

- `pnpm --filter @zn-ai/zn-agent-core typecheck` — 绿
- `pnpm --filter @zn-ai/zn-agent-core build` — 绿 + `dist/opencc-src/types/permissions.js` 存在且 < 5KB
- `pnpm --filter @zn-ai/zai typecheck` — 绿
- `pnpm --filter @zn-ai/zai test` — 全绿,4 处 mock 改路径后通过
- 新增 `permission-import-path.test.ts` — 4 个静态扫描断言全过

### Smoke

- `pnpm --filter @zn-ai/zai dev`
- curl `POST /api/agent/prompt` 用 `permissionMode: 'plan'` — zod enum 解析正常
- 检查 `~/.zai/logs/...` 无新错误

## 回滚

按风险递增 3 档:

**R1** — 改回 import 路径(30 秒):
```bash
git checkout packages/zai/src/server/routes/agent.ts \
           packages/zai/src/server/services/permissionMode.ts \
           packages/zai/test/server/*.test.ts \
           packages/zai/test/integration/agent.test.ts
```

**R2** — 移除新 export(1 分钟):
- `git checkout packages/zn-agent-core/package.json packages/zn-agent-core/scripts/bundle-opencc.ts`
- `rm -rf packages/zn-agent-core/dist/opencc-src/`
- 重跑 `pnpm --filter @zn-ai/zn-agent-core build`

**R3** — 完全 revert commit(本地分支未推时):
- `git reset --hard HEAD^`

## 后续轮次(不在本 spec)

本 spec 仅触及 A 档中的 `permissions.ts`。下一轮可考虑:

- `compat/cwdStore.ts` 中 `readTrailer()` 删除(`grep` 确认无消费者)
- 11 个 stale 文件头注释清理
- `README.md` 中 `@zn-ai/zai-agent-core` 引用替换
- B 档审计: MCP pool / plugin runtime / hook runner 委托可行性

## 通用约束(apply to 后续所有 compat 轮次)

源代码里有 UI 调用 / 权限判断需要 UI 交互的(例如 opencc 的 `Tool.checkPermissions` 返回 `'ask'` 弹权限对话框、`runPreToolUseHooks` 注入 `case 'stop'` 等),直接改原代码跳过,返回 `'allow'` / `true` 等允许值。**不**留 stub、**不**抛 error,真 WEB UI 配置后阶段再补。

参考现成实现:

- `forceAllowCheckPermissions`(`packages/zn-agent-core/src/compat/tools/opencc/builtin.ts`)— 强制 always-allow vendor Tool 的 `checkPermissions`
- `__zaiSkipPreToolUseHooks` flag(`packages/zn-agent-core/src/compat/runtime/agentRuntime.ts`)— zai runtime 下跳过 vendor PreToolUse hooks 的 `stop` yield

后续 B 档委托时,凡触及 vendor / compat 的 permission gate / UI prompt,**优先短路**而非完整实现 UI 桥接。