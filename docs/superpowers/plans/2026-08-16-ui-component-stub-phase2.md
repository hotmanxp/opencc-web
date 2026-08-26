# 二期:继续削减 agent-core bundle 中的 UI/渲染代码

## Context

一期(`2026-08-16` 已在 `scripts/bundle-opencc.ts` 落地)通过 `uiComponentStubPlugin` 把 `components/` 下纯组件模块 stub 成空组件,`opencc-core.mjs` 从 **17.08MB → 15.55MB(省 1.55MB,8.9%)**,71 个相关测试 + zai dev 冒烟全过。

一期**明确留到二期**的部分(见一期 plan「暂不动 / 留给二期」):

| 范围 | 一期结束时贡献 | 说明 |
|------|------|------|
| `commands/` 目录 | 884KB | 命令模块混排组件与逻辑(`call` 回调是运行时路径),需精准 AST 替换组件函数体 |
| `ink/` 目录 | 378KB | 子模块被 `utils/markdown.ts`、`utils/Cursor.ts`、`bridge/*` 等 import 纯函数(`stringWidth` 等),需先拆分"纯函数工具"与"渲染引擎" |
| `design-system/ThemeProvider.tsx` 组件 | 小 | `useTheme` 等 hooks 被 `.ts` 引用,组件 JSX 需文件内 AST 替换 |

二期目标:在**不触碰运行时逻辑**的前提下,把上述范围再砍掉 ~700-1000KB,bundle 从 15.55MB → ~14.5-14.8MB。

## 二期前置调查结论(已确认)

1. **命令注册层 vs 实现层分离**:`commands/<name>/index.ts` 只是 `satisfies Command` 的注册对象,`load: () => import('./impl.js')` 是**动态 import**;真正的实现(`provider.tsx`/`effort.tsx` 等,含 `call: LocalJSXCommandCall` 回调和 UI 组件)在同一文件里混排。esbuild 非 splitting 模式把动态 import 内联进主 bundle → 组件随实现层进了 bundle。
   - 证据:`commands/provider/index.ts` 仅 `{ type: 'local-jsx', name, description, load }`;`commands/provider/provider.tsx` 同时导出 `TextEntryDialog`/`ProviderWizard`(组件)与 `buildProviderManagerCompletion`/`call`(逻辑)。

2. **`ink/stringWidth.ts` 是纯函数工具模块,必须保留**:被 `utils/markdown.ts:222-266`(表格对齐)、`utils/format.ts`、`utils/truncate.ts`、`utils/terminal.ts`、`utils/Cursor.ts`、`native-ts/color-diff/index.ts` 等**运行时工具**真实调用。`supports-hyperlinks.ts` 同样被 `utils/markdown.ts` 引用。
   - `ink/parse-keypress.ts` **无任何非 ink 引用**(grep 空),可安全 stub。

3. **`ThemeProvider.tsx`** 导出 `ThemeProvider` 组件 + `useTheme`/`useThemeSetting`/`usePreviewTheme` hooks;`useTheme` 被 `hooks/useCopyOnSelect.ts` 引用。一期因无法整文件 stub 而保留整文件(组件 JSX 留在 bundle)。

## 工作块 A:commands/ 命令实现层的组件函数体替换(主收益)

**目标**:把命令实现文件(如 `commands/provider/provider.tsx`)里的**组件函数体**替换为 `return null`,保留同文件的其他导出(`call` 回调、`buildXxx` 纯函数、类型)。

**做法**:在 `scripts/bundle-opencc.ts` 的 `uiComponentStubPlugin`(或新增 `commandComponentStubPlugin`)中,对**命中命令实现文件路径**的模块走 `onLoad` **原文件 AST 变换**而非整模块 stub:

```typescript
// 伪代码 —— ts.createSourceFile + 顶层节点遍历 + 替换函数体
const sf = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true)
function walk(node: ts.Node): ts.Node {
  // 只处理顶层(不递归进 function body 内部)
  if (ts.isFunctionDeclaration(node) && isComponentShape(node)) {
    // 函数名大写开头 & 返回 JSX/ReactElement —— 替换函数体为 return null
    node.body = ts.factory.createBlock(
      [ts.factory.createReturnStatement(ts.factory.createNull())], true)
  }
  // const X = () => <div/> 箭头函数组件、memo(...)/forwardRef(...) 包装的组件
  // 同样替换为 () => null
  return ts.visitEachChild(node, walk, undefined)
}
const printed = ts.createPrinter().printFile(ts.visitNode(sf, walk))
```

**组件判定规则**(保守,只替换"确实是组件"的):
- `function Xxx({...})` 或 `const Xxx = ({...}) => ...`:名字首字母大写(已确认这些命令实现文件遵循大写驼峰组件名约定,见 `components/AGENTS.md`「Named exports」)
- `export const Xxx = memo(...)` / `forwardRef(...)` 包装:同规则
- `default export` 是组件的:替换为 `() => null`

**必须保留**(不做替换):`call`、`load`、`getPromptForCommand`、`buildXxx`、`getXxx` 等非组件导出,以及所有 `.ts` 命令文件(`commands/clear/index.js` 这类注册层的类型引用)。

**文件清单来源**:`find src/opencc-src/commands -name '*.tsx'`(实现层组件文件)。注册层 `index.ts` 不含组件,esbuild 内联的动态 import 指向 `.tsx` 实现。

**预期收益**:~400-600KB(实现层组件 JSX + 它们依赖的 design-system 组件残留——但这些依赖已部分被一期 stub,实际收益需构建后实测)。

## 工作块 B:ink/ 拆分 stub(~300KB)

**思路**:把 `ink/` 分成"纯函数工具(保留)"和"渲染引擎 + 组件(stub)"。

**保留**(被运行时工具/非 ink 文件真实调用):
- `ink/stringWidth.ts`(`utils/markdown.ts` 等)
- `ink/supports-hyperlinks.ts`(`utils/markdown.ts`)
- 其他**被 `utils/*`、`bridge/*`、`native-ts/*` 直接 import 的 ink 纯函数**(实施前用 `grep -rln "ink/xxx" src/opencc-src --include=*.ts | grep -v '/ink/'` 逐项核对)

**stub**(渲染引擎 + React 组件树,只有 ink 渲染时才执行,zai 从不渲染):
- `ink/components/**`(Box/Text/Button/App 等 React 组件)—— 复用一期 `UI_COMPONENT_STUB_DIRS` 机制,加 `components` 子目录 → 实际是 `ink/components`
- `ink.tsx` 顶层 re-export 文件(render/createRoot/Ansi 等)—— 但注意 `main.tsx` 对它 `import type { Root }`(类型,构建擦除);且**没有任何文件 import ink.tsx**(一期已确认),它可能已完全 tree-shake;确认后不用动
- 渲染引擎:`ink/render-node-to-output.ts`、`ink/render-to-screen.ts`、`ink/renderer.ts`、`ink/screen.ts`、`ink/reconciler.ts`、`ink/output.ts`、`ink/frame.ts`、`ink/optimizer.ts`、`ink/root.ts`、`ink/instances.ts`、`ink/parse-keypress.ts`(无引用)、`ink/layout/**`、`ink/termio/**` 等 —— 通过把 `ink/reconciler.ts`、`ink/root.ts` 等**渲染入口** stub(export 全部空化),让 esbuild 把依赖它们的渲染子树 tree-shake 掉

**关键校验**:stub 前必须确认 zai 运行路径上没有任何代码调用 `ink.render()` / `createRoot()` / `renderToScreen()`。方法:
1. grep 全库(opencc-src + compat + zai)对 `ink.js`(顶层)的 import(一期已确认只有 `main.tsx` 的 type-only import)
2. grep 对 `renderToScreen`/`createRoot` 的调用方(预期只有 ink 内部 + main.tsx/CLI 入口)

**预期收益**:~300KB(ink/ 378KB 中纯函数工具 ~50KB 保留,其余 stub)。

## 工作块 C:ThemeProvider.tsx 组件 stub(小收益,顺手做)

**做法**:对 `components/design-system/ThemeProvider.tsx` 做**文件内 AST 替换**——只把 `ThemeProvider` 组件函数体替换为 `return null`,**保留** `useTheme`/`useThemeSetting`/`usePreviewTheme` hooks(它们读 context,hooks 本身逻辑很短,不影响体积大头,但组件 JSX 被砍)。

**前置条件**:工作块 A 的"文件内 AST 变换"落地后,此文件直接复用同一变换工具(把"函数体替换"应用到一个"混排文件保留清单"里的指定组件名)。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 命令 `call` 回调内部引用组件(渲染命令 UI),stub 后 `call` 返回 null | zai 从不触发 vendor 命令 UI 渲染(有 compat 命令层);即便触发,组件返回 null 而非抛错。用 `commands/` 相关单测兜底 |
| `ink/` 纯函数工具被误判为可 stub,导致运行时 `X is not a function` | 实施前逐项 grep 核对 ink 子模块的**非 ink 引用方**;把被 `utils/*`、`bridge/*`、`native-ts/*` 引用的加入"保留清单"(`UI_COMPONENT_KEEP_FILES` 模式扩展) |
| 组件判定规则误伤 `buildXxx` 等逻辑函数(如大写开头但非组件) | 判定增加"返回 JSX/`React.createElement`"信号;用 `isJsxElement`/`isJsxFragment`/`isJsxSelfClosingElement` 检查函数返回体;命中存疑的加入保留清单 |
| esbuild 动态 import 拆分行为变化 | 保持 `format: 'esm'` + 单 outfile 不变,不引入 splitting;如动态 import 内联行为在某个 esbuild 版本变化,构建会显式报错而非静默 |

## 验证(沿用一期,只跑相关测试)

1. `pnpm -w run build:core` —— 必须成功;`dist/opencc-core.mjs` 预期 15.55MB → ~14.5-14.8MB
2. 体积量化:复用一期 `measure-bundle3.mjs` 风格临时脚本,对比 `commands/` 与 `ink/` 对输出的字节贡献
3. 单元测试:
   ```bash
   pnpm --filter @zn-ai/zn-agent-core test test/unit/server test/unit/commands test/unit/permissions
   pnpm --filter @zn-ai/zai test test/server/routes/commandsCrud.test.ts test/server/clear-command.test.ts test/server/instance-supervisor-wiring.test.ts test/services/commands/builtin.status.test.ts
   ```
   重点:`commands` 相关测试(命令注册/解析/技能索引构建不受影响)、`openccRuntime-query.test.ts`(QueryEngine 走完整命令表)
4. zai dev 冒烟:`pnpm --filter @zn-ai/zai dev`,`curl http://localhost:<api-port>/api/health` → 200,`[zai] Interactive mode` 日志出现(命令表加载 OK)
5. ego-browser:受 SSE 长连接阻塞限制(memory 已知),深度交互由用户验证;至少确认 zai dev 启动无即时崩

## 实施顺序建议

1. **工作块 A**(最大收益,~500KB)先做 —— 落地"文件内 AST 组件函数体替换"工具,这是 B/C 的共用基础
2. **工作块 B**(~300KB)—— 先做 ink 纯函数引用方核对,再 stub 渲染子树
3. **工作块 C**(小)—— 复用 A 的变换工具,一行清单
4. 每块独立构建 + 跑相关测试 + 提交,不合并

## 关键文件

- `packages/zn-agent-core/scripts/bundle-opencc.ts`(唯一改动文件,一期已加 `uiComponentStubPlugin`)
- 参考一期实现:`extractExportedNames`(TS AST 顶层 export 提取)、`buildUiStub`、`UI_COMPONENT_STUB_DIRS` / `UI_COMPONENT_KEEP_FILES` 清单
- 命令实现层文件:`src/opencc-src/commands/*/...tsx`
- ink 渲染入口:`src/opencc-src/ink/{reconciler,root,renderer,render-node-to-output,screen}.ts` + `ink/components/`
