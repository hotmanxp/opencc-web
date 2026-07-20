# zai-agent-core GrepTool — ripgrep 升级

> 文档版本: 1.0 · 2026-07-17 · 状态: 设计已敲定, 待用户 review

## 0. 背景

`packages/zai-agent-core/src/tools/GrepTool/GrepTool.ts` 是 zai-agent-core 唯一的 ripgrep 接入点。当前实现只有 158 行, 直接 `child_process.spawn('rg', args, ...)`, 仅有基础 ENOENT → Node.js fallback 兜底, 缺失:

- **超时与 kill 策略** — 不传 `timeout` / `killSignal`, 失控 ripgrep 会无限挂起
- **EAGAIN 重试** — Docker / CI 资源紧张时 `os error 11` 直接暴露给 LLM
- **buffer 溢出保护** — 不限制 stdout, 大仓库 200k+ 文件会爆 OOM
- **macOS codesign** — vendor 二进制首次启动需 `--sign -` + 去 quarantine
- **builtin 二进制分发** — 没有 vendor, 没有 `@anthropic-ai/ripgrep-bin` 兜底
- **友好错误** — ENOENT 等关键错误没有"安装提示"

OpenCC 的 `src/utils/ripgrep.ts` 镜像(`packages/zai-agent-core/src/opencc-internals/utils/ripgrep.ts`,786 行)有完整上述能力, 但:
1. 该文件在 `opencc-internals/`(只读镜像, `tsc -b` 排除), 当前实际**未被运行时引用**
2. 依赖 `bun:bundle` 与 `Bun.spawn`, zai-agent-core 是 Node + tsx, 无法直接复用
3. 镜像目录是"阅读性快照", 设计上不允许被 runtime import

**核心约束**: 不下沉独立 utils 模块(用户偏好), 同步脚本白名单不动, 不新建独立导出文件。

## 1. 方案

**内联增强 `GrepTool.ts`** — 把 OpenCC ripgrep.ts 的关键能力吸收进 `GrepTool.ts` 同文件内的 private helper, 不冒泡到 `src/utils/`、不动 `sync-from-opencc` 白名单。

### 1.1 文件改动

| 路径 | 改动 | 行数估算 |
|---|---|---|
| `packages/zai-agent-core/src/tools/GrepTool/GrepTool.ts` | 重写: 内联 `resolveRgPath` / `codesignRipgrepIfNecessary` / `runRipgrep` / `spawnOnce`, 保留现有 `fallbackSearch` | 158 → ~400 |
| `packages/zai-agent-core/src/tools/GrepTool/GrepTool.test.ts` | 新增, mock `child_process.spawn` 单测 | ~300 |
| `packages/zai-agent-core/vendor/ripgrep/rg-{platform}-{arch}{.exe}` | 新增, 3 个二进制(从 OpenCC cp), 进 git | ~11 MB |
| `packages/zai-agent-core/scripts/fetch-vendor-ripgrep.mjs` | 新增, 开发者本地首次拉取二进制(从 OpenCC 直接 cp) | ~20 |

### 1.2 不动

- `packages/zai-agent-core/src/opencc-internals/`(只读镜像,保留)
- `packages/zai-agent-core/scripts/sync-from-opencc.ts` 白名单(`utils/ripgrep.ts` 等保留)
- `packages/zai-agent-core/.gitignore`(`vendor/ripgrep/` 不进 ignore)
- GrepTool 对外签名(`name`, `inputSchema`, `call(rawInput, ctx): Promise<{ output, isError? }>`, `isReadOnly`)

## 2. 架构与数据流

```
┌──────────────────────────────────────────────────────────────────┐
│              GrepTool.call(rawInput, ctx)                         │
│   ├─ searchPath = isAbsolute(input.path) ?? resolve(ctx.cwd, …)  │
│   ├─ mode = input.output_mode ?? 'content'                        │
│   └─ rgResult = await runRipgrepWithFallback(input, searchPath)   │
│                                                                   │
│        ┌────────────────────────────────────────────────┐         │
│        │ runRipgrepWithFallback(input, searchPath)     │         │
│        │  1. resolveRgPath() → { rgPath, mode }        │         │
│        │     ├─ vendor/ripgrep/rg-{plat}-{arch}{.exe}  │         │
│        │     ├─ which('rg') / where('rg')              │         │
│        │     └─ null  ← 触发 fallback                  │         │
│        │  2. codesignRipgrepIfNecessary(rgPath)         │         │
│        │     (仅 darwin + 命中 vendor)                  │         │
│        │  3. spawnOnce(args, j=1=false)                 │         │
│        │     ├─ exit 0/1 → handleMatch()               │         │
│        │     ├─ EAGAIN stderr → spawnOnce(args, j=1)    │         │
│        │     ├─ ENOENT → resolveRgPath() 降一级         │         │
│        │     ├─ 超时 SIGTERM → 包装 timeout 提示         │         │
│        │     └─ buffer 溢出 → 截断输出                  │         │
│        │  4. 2 级全失败 → null                         │         │
│        └────────────────────────────────────────────────┘         │
│                                                                   │
│   if (rgResult !== null) return rgResult                          │
│   return await fallbackSearch(input, searchPath, mode)            │
│     (现有 Node.js 实现, 无 ripgrep 时降级)                          │
└──────────────────────────────────────────────────────────────────┘
```

## 3. 配置与超时

| 项 | 值 | 来源 |
|---|---|---|
| 默认超时 | 20s (WSL 60s) | `getPlatform() === 'wsl' ? 60_000 : 20_000` |
| 环境变量超时 | `process.env.CLAUDE_CODE_GLOB_TIMEOUT_SECONDS * 1000` | parseInt 失败回退默认 |
| killSignal | `'SIGKILL'`(非 win32), `undefined`(win32) | execFile killSignal |
| SIGTERM → SIGKILL 升级 | 超时发 SIGTERM, 5s 未退 → SIGKILL | 防止 uninterruptible I/O |
| maxBuffer | 20 MB | 200k+ 文件 |
| 输出截断 | stdout/stderr 各自超过 20 MB 截断 | buffer 溢出友好降级 |

## 4. resolveRgPath() 3 级解析

按顺序首个命中即返回:

1. **`vendor/ripgrep/rg-{plat}-{arch}{.exe}`** (从 OpenCC 项目直接 cp 二进制, 无 npm 依赖)
   - `platform ∈ {darwin, win32}`(OpenCC 现有二进制仅 3 个, 见下表)
   - `arch ∈ {arm64, x64}`
   - `existsSync` 命中
2. **`execFile('which', ['rg'])`** (mac/linux) 或 **`execFile('where', ['rg'])`** (win32)
   - exit 0 且 stdout 有效
3. **null** → 触发 `fallbackSearch`

**vendor 二进制文件名约定** (从 OpenCC `/Users/liangxuechao572/code/opencc/vendor/ripgrep/` 直接 cp):

| platform | arch | 文件名 |
|---|---|---|
| darwin | arm64 | `rg-darwin-arm64` |
| darwin | x64 | `rg-darwin-x64` |
| win32 | x64 | `rg-win32-x64.exe` |

不识别 platform/arch → 跳过 vendor, 继续 system。linux 无 vendor 二进制, 走 system rg。

**依赖变更**: 不新增 `@anthropic-ai/ripgrep-bin` npm 依赖, vendor 二进制由 OpenCC 直接 cp, 由 `scripts/fetch-vendor-ripgrep.mjs` 维护。

## 5. codesignRipgrepIfNecessary()

仅当 `process.platform === 'darwin'` 且命中 vendor 级(无 npm 级, 系统 rg 不需 codesign)时执行。**全局 lazy 标志** `codesignDone` 保证只跑一次。

步骤:
1. `codesign -vv -d <path>` → 找 `'linker-signed'` 行
2. 不存在 → 直接 return
3. `codesign --sign - --force --preserve-metadata=entitlements,requirements,flags,runtime <path>`
4. `xattr -d com.apple.quarantine <path>`
5. 失败 → `console.error`(同步, 仅首启动一次)

非 darwin / 命中 system / 命中 null → 不调。

## 6. spawnOnce() 与 EAGAIN 重试

**ripgrep 参数拼接**(content 模式示例):
```
--no-heading --line-number
[-C N]                         # content + context
[--files-with-matches]         # files_with_matches 模式
[--count]                      # count 模式
[-i]                           # ignore_case
[--glob <g>]                   # glob 过滤
-- <pattern> <searchPath>
```

**EAGAIN 重试规则**:
- 触发: `stderr` 包含 `'os error 11'` 或 `'Resource temporarily unavailable'`
- 重试参数: **仅本次**加 `-j 1`(不全局持久化 —— OpenCC 注释明确指出持久化会在大 repo 触发新超时)
- 二次失败 → 走通用错误处理

## 7. 错误处理矩阵

| 退出 / 信号 | 输出 | isError |
|---|---|---|
| `code === 0`(有匹配) | `Found N matches:\n<lines>`(N>200:`Found N+ matches (showing first 200):…`) | false |
| `code === 1`(无匹配) | `No matches` | false |
| `code === 2`(usage error) | `ripgrep error: <stderr>` | true |
| `signal === 'SIGTERM'` + 0 行 | `ripgrep search timed out after N seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.` | true |
| `signal === 'SIGTERM'` + 部分行 | `Found N matches (search may be incomplete, timed out after N seconds):\n<lines>` | false |
| `code === 'ABORT_ERR'` | `Search aborted.` | true |
| `code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | `Found N+ matches (output truncated):\n<lines>` | false |
| `error.code === 'ENOENT'` | 不向上抛, 内部降级下一级 rg | — |
| EAGAIN stderr | 静默重试 -j 1, 二次失败走 SIGTERM 分支 | — |

**Node.js fallback(`fallbackSearch`)现有行为不变**:
- 单文件: 直接读 + 正则
- 目录: `collectFiles(dir, out, 2000)` 限制
- glob 过滤: 小写 `matchGlob()` (`**` / `*` / `?`)
- 跳过 `node_modules`、`.git`、`.` 开头项

## 8. fetch-vendor-ripgrep.mjs

开发者本地首次拉取二进制用, 不进 `postinstall`, 不进 CI:

```js
// scripts/fetch-vendor-ripgrep.mjs
// 从 OpenCC 项目直接 cp 二进制, 无 npm 依赖
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const openccVendor = '/Users/liangxuechao572/code/opencc/vendor/ripgrep'
const zaiVendor = join(__dirname, '..', 'vendor', 'ripgrep')
mkdirSync(zaiVendor, { recursive: true })

for (const f of ['rg-darwin-arm64', 'rg-darwin-x64', 'rg-win32-x64.exe']) {
  copyFileSync(join(openccVendor, f), join(zaiVendor, f))
  console.log(`copied ${f}`)
}
```

运行: `node scripts/fetch-vendor-ripgrep.mjs`(OpenCC 项目需在 `/Users/liangxuechao572/code/opencc`)。

## 9. 测试策略

**范围**: 单测 mock `child_process.spawn`, 不依赖真实 rg, 跑 < 5s。

**测试文件**: `packages/zai-agent-core/src/tools/GrepTool/GrepTool.test.ts`(新增)

**测试矩阵**:

| 用例 | mock 返回 | 期望 |
|---|---|---|
| vendor 命中 + 1 行匹配 | `spawn→{code:0, stdout:'a.js:1:foo'}` | `Found 1 matches:\na.js:1:foo` |
| vendor miss → npm 包命中 | vendor `existsSync=false`, ripgrep-bin `existsSync=true` | spawn 路径含 `ripgrep-bin` |
| vendor/npm miss → system which rg | vendor/npm `existsSync=false`, `which→{code:0}` | spawn 用 `'rg'` |
| 4 级全 miss → fallback | `resolveRgPath→null` | 不调 spawn, 走 `fallbackSearch` |
| ENOENT → 降级 | spawn error `{code:'ENOENT'}` | 自动回退到 npm → system → fallback |
| EAGAIN 重试 | 第一次 `code:2, stderr:'os error 11'`, 第二次 `code:0` | args 含 `-j 1` |
| 超时 SIGTERM | spawn close `{signal:'SIGTERM'}` | timeout 包装输出 |
| buffer 溢出 | `code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | 输出含 `(output truncated)` |
| mode=files_with_matches | — | args 含 `--files-with-matches` |
| mode=count | — | args 含 `--count` |
| ignore_case | — | args 含 `-i` |
| glob='*.ts' | — | args 含 `--glob *.ts` |
| context=3 | — | args 含 `-C 3` |
| 模式 2(stderr) | `code:2, stderr:'bad regex'` | `ripgrep error: bad regex`, `isError:true` |
| 模式 1(无匹配) | `code:1` | `No matches` |
| MAX_RESULTS=200 截断 | 251 行 | `Found 251+ matches (showing first 200):` |
| fallback path 无效 | 无 rg, `/nonexistent` | `Path not found: …`, `isError:true` |
| fallback 正则非法 | 无 rg, `pattern='['` | `Invalid regex: …`, `isError:true` |
| codesign mac 已签名 | `codesign -vv -d` 无 `linker-signed` | 不调 `--sign -` |
| codesign mac 未签名 | `codesign -vv -d` 含 `linker-signed` | 期望 `--sign -` + `xattr -d` |
| codesign linux 跳过 | platform != darwin | 不调 codesign |
| CLAUDE_CODE_GLOB_TIMEOUT_SECONDS=60 | env=60 | spawn timeout=60000 |
| absolute path | input.path=`/abs/foo` | target=`/abs/foo` |
| relative path | input.path=`./foo`, cwd=`/work` | target=`/work/foo` |

mock 框架: vitest `vi.mock('node:child_process')` + `vi.mocked(existsSync)`, 不走真实 fs。

## 10. 风险与边界

1. **vendor 二进制的可执行位** — 从 OpenCC `/Users/liangxuechao572/code/opencc/vendor/ripgrep/` cp 的二进制需保留 chmod 755。`copyFileSync` 默认会保留权限, 但 Windows 上不被识别为可执行 → 必须配 `.exe` 后缀。
2. **包体增大** — 3 个 vendor 二进制约 11 MB, 影响 npm 包下载, zai-agent-core 仍发到 nexus internal registry, 内部网络不受影响。linux 用户需自备 system rg。
3. **Windows 行为** — `execFile('where', ['rg'])` 在 Windows 上确实存在, 但 `spawn` 默认信号行为不同 → 使用 `windowsHide: true`, killSignal 用 `undefined`(同 OpenCC)。
4. **Bun 不支持** — 不引入 `bun:bundle` 与 `Bun.spawn`, 与 zai 现有 Node + tsx runtime 保持一致。
5. **同步脚本副作用** — 不动 `sync-from-opencc.ts` 白名单, 镜像中的 `utils/ripgrep.ts` 等保留作为参考, 但 zai-agent-core 运行时**不依赖**镜像。

## 11. 不做 (YAGNI)

- ❌ 不暴露 `ripGrepStream` 流式 API(zai GrepTool 给 LLM 一次性看)
- ❌ 不引入 npm 依赖(从 OpenCC 直接 cp 二进制, 不再走 `@anthropic-ai/ripgrep-bin`)
- ❌ 不暴露 `RipgrepTimeoutError` / `RipgrepUnavailableError` 给上层(GrepTool 内部处理)
- ❌ 不重新设计 `fallbackSearch`(现有实现够用)
- ❌ 不动 `opencc-internals/`(只读镜像)
- ❌ 不进 `postinstall`(vendor 由开发者手动拉取 + git 跟踪)