# zai 默认 4GB 堆内存实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai 在未显式配置时自动以 `--max-old-space-size=4096` 启动，同时保留用户已有的 Node.js 堆内存配置。

**Architecture:** 在现有 `packages/zai/bin/zai.js` 包装器中增加一次性自重启逻辑。包装器检查 `process.execArgv` 和 `NODE_OPTIONS`，无堆参数时用当前 Node 可执行文件重新启动自身；有用户配置时直接加载现有 CLI。通过内部环境标记避免重启循环，并透传参数、环境和退出状态。

**Tech Stack:** Node.js ESM、`node:child_process`、`node:path`、现有 zai CLI、仓库测试工具。

## Global Constraints

- 默认值固定为 `--max-old-space-size=4096`。
- 用户通过 `NODE_OPTIONS` 或 Node 启动参数指定的堆上限优先。
- 不修改 API、前端或业务运行时。
- 不覆盖用户现有的未提交修改 `src/web/src/components/markdown/MarkdownText.tsx`。
- 自重启失败必须以非零状态退出，不能静默降级。

---

### Task 1: 为启动包装器增加堆参数判定和自重启

**Files:**
- Modify: `/Users/ethan/code/opencc-web/packages/zai/bin/zai.js`
- Test: `/Users/ethan/code/opencc-web/packages/zai/bin/zai.test.js` using Node's built-in `node:test` and `node:child_process`; do not add a new test framework or package dependency.

**Interfaces:**
- Produces: 启动包装器继续加载 `../dist/cli/index.js`；无用户堆参数时先以 `--max-old-space-size=4096` 重启。

- [ ] **Step 1: 写最小失败测试或 smoke test**

测试应覆盖以下行为：

```js
// 伪代码：测试实际可执行 wrapper 时使用 child_process.spawnSync
assert.equal(result.status, 0)
assert.match(result.stdout + result.stderr, /4096|heap/) // 子进程可观察到默认参数
```

如果直接导入 wrapper 会立即启动 CLI，测试改为对抽取出的纯函数测试；纯函数至少接受 `execArgv` 与 `nodeOptions`，返回是否已有堆参数。

- [ ] **Step 2: 运行测试确认当前实现不满足默认 4GB**

运行：

```bash
node --test packages/zai/bin/zai.test.js
```

预期：默认堆参数断言失败，因为当前 wrapper 只动态导入 CLI。

- [ ] **Step 3: 实现堆参数检测**

在 `zai.js` 中增加最小实现：

```js
const DEFAULT_HEAP_ARG = '--max-old-space-size=4096'
const RE_HEAP_ARG = /^--max[-_]old[-_]space[-_]?size(?:=|$)/

function hasHeapArg(args) {
  return args.some((arg) => RE_HEAP_ARG.test(arg))
}

function hasUserHeapLimit() {
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  return hasHeapArg(process.execArgv) || hasHeapArg(nodeOptions.split(/\s+/).filter(Boolean))
}
```

检测必须同时识别连字符和下划线形式，并避免把默认参数重复注入。

- [ ] **Step 4: 实现一次性自重启**

使用 `spawnSync` 启动当前脚本：

```js
const RESTART_MARKER = 'ZAI_HEAP_RESTARTED'

if (!hasUserHeapLimit() && process.env[RESTART_MARKER] !== '1') {
  const child = spawnSync(
    process.execPath,
    [DEFAULT_HEAP_ARG, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      env: { ...process.env, [RESTART_MARKER]: '1' },
      stdio: 'inherit',
    },
  )
  if (child.error) {
    console.error(`[zai] Failed to restart with ${DEFAULT_HEAP_ARG}:`, child.error)
    process.exit(1)
  }
  process.exit(child.status ?? 1)
}
```

实际实现应使用当前文件的 `fileURLToPath(import.meta.url)`，避免依赖当前工作目录；保留现有动态导入逻辑作为重启后的执行路径。

- [ ] **Step 5: 增加覆盖优先级测试**

验证以下输入不会触发默认参数重复注入：

```js
assert.equal(hasHeapArg(['--max-old-space-size=8192']), true)
assert.equal(hasHeapArg(['--max_old_space_size=8192']), true)
assert.equal(hasHeapArg([]), false)
```

并用子进程验证 `NODE_OPTIONS=--max-old-space-size=8192` 时直接进入 CLI。

- [ ] **Step 6: 运行验证**

运行：

```bash
node --check packages/zai/bin/zai.js
bun run typecheck
bun run test
```

预期：语法检查通过，zai-agent-core 类型检查和现有测试不回归；与启动 wrapper 相关的定向测试通过。

- [ ] **Step 7: 提交实现**

```bash
git add packages/zai/bin/zai.js packages/zai/bin/zai.test.js
git commit -m "feat(zai): default node heap to 4GB"
```

只提交本任务文件，不要包含 `src/web/src/components/markdown/MarkdownText.tsx` 或其他无关改动。

### Task 2: 验证构建产物和实际启动

**Files:**
- Modify: 无
- Test: 构建后的 `packages/zai/bin/zai.js` 与 `packages/zai/dist/cli/index.js`

**Interfaces:**
- Consumes: Task 1 的 wrapper 行为。
- Produces: 实际 `zai` 启动时默认 4GB，显式配置时保留用户值。

- [ ] **Step 1: 构建 zai**

运行仓库现有 zai 构建命令：

```bash
cd packages/zai
bun run build
```

确认 `packages/zai/dist/cli/index.js` 存在。

- [ ] **Step 2: 验证默认启动参数**

在不设置 `NODE_OPTIONS` 的环境下启动 wrapper，使用 CLI 的帮助或版本参数让进程快速退出：

```bash
env -u NODE_OPTIONS node packages/zai/bin/zai.js --help
```

预期：CLI 正常输出帮助，不出现重启循环或启动错误。

- [ ] **Step 3: 验证用户覆盖**

```bash
NODE_OPTIONS=--max-old-space-size=8192 node packages/zai/bin/zai.js --help
```

预期：CLI 正常输出帮助，wrapper 不额外注入 4096 参数。

- [ ] **Step 4: 检查 git 状态**

```bash
git status --short
```

预期：只保留用户原有的 `src/web/src/components/markdown/MarkdownText.tsx` 修改；本任务实现文件已提交。
