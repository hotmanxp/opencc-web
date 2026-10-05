# Vendor 类型闸门排除主入口 bundle-entry.ts —— 已发布 API 恰好是唯一不被检查的文件

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 中高（类型闸门对其余部分有效，唯独对发布面失明；已造成 3 个真实错误）

## 摘要

`tsconfig.typecheck.json` 把 `src/bundle-entry.ts` 排除在类型检查之外。
而这个文件是 `dist/bundle-entry.d.ts` **唯一的生成来源** ——
也就是这个包**对外发布的全部类型契约**。

结果是 `pnpm typecheck:vendor` 绿灯通过，而**发布面本身有 3 个真实错误**：
一个重名类型被静默吞掉、一个根本不存在的导出被写进了 d.ts。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zn-agent-core/tsconfig.typecheck.json` | 20 | `"src/bundle-entry.ts"` 在 `exclude` 里 |
| `packages/zn-agent-core/scripts/bundle-opencc.ts` | 470 | `generateBundleEntryDts()` —— d.ts 由该文件机械复制 |
| `packages/zn-agent-core/src/bundle-entry.ts` | 213, 281 | 重名 `TaskStatus` 导出 |
| 同上 | 276 | 导出 `bodyAfterFrontmatter` |
| 同上 | 251 | 注释「仅做出口,会被 tree-shake 掉」 |
| `packages/zn-agent-core/dist/bundle-entry.d.ts` | 137-138 | 把该导出写进了已发布 d.ts |
| `packages/zn-agent-core/src/compat/taskListStore.ts` | 30 | `TaskStatus` 第一个定义 |
| `packages/zn-agent-core/src/opencc-src/server/taskFactoryFiles.ts` | 8 | `TaskStatus` 第二个定义 |

## 错误 1：重复的 `TaskStatus`，后者胜出

```ts
// src/compat/taskListStore.ts:30
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

// src/opencc-src/server/taskFactoryFiles.ts:8
export type TaskStatus = 'queued' | 'processing' | 'paused' | 'verifying' | 'done' | 'failed'
```

两个**语义完全不同**的 union 用了同一个名字。`bundle-entry.ts:213` 和 `:281`
各自导出一个，TypeScript 报 duplicate identifier —— 但因为该文件被 exclude，
这个错误从未被看见。

**已验证**：对构建产物 `dist/bundle-entry.d.ts` 做消费者探针，第二个声明胜出，
所以发布出去的 `TaskStatus` 是任务工厂那一套。
`packages/zai/src/server/routes/superTasks.ts:340` 调
`markTaskStatus(t.id, 'processing-tasks', { status: 'paused' })` —— 与任务工厂
union 一致，所以当前 zai 自己能编过。但任何按 `taskListStore` 语义写
`status: 'pending'` 的消费者会**类型通过、运行时语义错误**。

`packages/zai/src/web/src/lib/taskApi.ts:8` 干脆自己本地定义了**第三套**
`TaskStatus` 来绕开这个坑 —— 一个重复类型已经逼出了三份定义。

## 错误 2：导出一个不存在的符号

```ts
// src/bundle-entry.ts:251（注释）
// generateTaskId/bodyAfterFrontmatter 仅做出口,会被 tree-shake 掉。
// :276（实际导出）
  bodyAfterFrontmatter,
```

它 re-export 自 `./opencc-src/server/taskFactoryFiles.js`，
但**该文件不导出 `bodyAfterFrontmatter`**（vendor 与上游
`/Users/ethan/code/opencc/src/` 均无此符号）。

**已验证**：

```
$ node -e "import('./dist/opencc-core.mjs').then(m=>console.log(typeof m.bodyAfterFrontmatter))"
undefined
$ grep -n bodyAfterFrontmatter dist/bundle-entry.d.ts
138:  bodyAfterFrontmatter,        ← 已发布 d.ts 声明它存在
```

任何消费者 `import { bodyAfterFrontmatter } from '@zn-ai/zn-agent-core'`
**类型检查干净，运行时拿到 `undefined`。**

`:251` 的注释说「仅做出口，会被 tree-shake 掉」—— 今天成立仅仅是因为
**没有任何东西 import 它**。任何人写第一行 import 就会踩到。

## 为什么第二道闸门也没拦住

`tsconfig.consumer.json` 只 typecheck 一个固定文件
（`test/integration/openccServer.consumer-typecheck.ts`），其自身注释承认：

> this tsc-based check does NOT catch unresolvable cross-module
> `import type` references in the published d.ts — TS's bundler resolution
> silently drops those.

探针实测确认了这个 drop：import 一个不存在的 `bodyAfterFrontmatter`
**产生 0 个 tsc 错误**。两道闸门都设计成检查别的东西，主入口正好落在
两者的空隙里。

## 修复

1. **把 `src/bundle-entry.ts` 从 `exclude` 移除**，让类型闸门覆盖它。
   若当初排除它是为了绕开某个具体错误，应改为在文件内用局部
   `// @ts-expect-error` 精确豁免那一行，而不是排除整个发布面。

2. **消除 `TaskStatus` 重名**。两个 union 语义不同，**必须重命名**
   （如 `TaskListStatus` / `FactoryTaskStatus`），不能靠导出顺序决定谁胜出 ——
   后者对读者是不可见的。同步清理 `packages/zai/src/web/src/lib/taskApi.ts:8`
   的第三份本地定义。

3. **删除 `bundle-entry.ts:276` 的 `bodyAfterFrontmatter` 导出**，
   并给 `:251` 的注释补一句「该符号在 taskFactoryFiles 中不存在，
   是历史遗留的幽灵导出」。

4. **给 `generateBundleEntryDts()` 加一道后置校验**：生成 d.ts 后跑一次
   `tsc` 检查它自身（哪怕只检查导出名的可解析性）。
   「生成物从未被当作生成物验证过」是这类 bug 的通用温床。

## 关联问题

- 同属 vendor 同步流程缺系统性校验的还有
  `docs/bugs/2026-10-05-vendor-write-symlink-bypass.md`：
  `da74a635` 用错误理由跳过了上游的安全补丁。两件事的共同根因是
  **vendor 同步依赖人工判断、缺少可执行的校验**。
- `5fc6bf22`（"vendor 类型闸门失明 + 25 个被吞掉的真实类型错误"）
  已经修过一次同类问题 —— 说明这条闸门此前就被发现是漏的，
  但排除项本身没被清理。
