# Bash 输出 ANSI 颜色渲染

> 让 Agent 对话流里的 Bash 卡片保留终端 ANSI 颜色,与原生终端一致。

## 背景与动机

zai 当前把 Bash tool 的 `stdout` / `stderr` 当作纯文本,通过 `linkifyText` 套一层 URL 识别后塞进 `<pre>`。ANSI 转义序列(`ESC[31m…`)作为可见字符直接渲染,出现"红字被打印成字面量"的问题:

```
> @zn-ai/zai@0.0.8 build /Users/liangxuechao572/code/opencc-web/packages/zai
> tsc -b && npm run build:web
...
[plugin builtin:vite-reporter]
(!) Some chunks are larger than 500 kB after minification.  Consider:
- Using dynamic import() to code-split the application
...
```

`npm warn config ignoring workspace config …` 在真实终端里是黄色,而 zai 界面把 `\x1b[33m` 当字面量显示。修复目标:解析 SGR,渲染成真实颜色,其它字符原样。

## 范围

**本期:**

- Agent 对话流里的 Bash 卡片(`toolRenderers/bash.tsx`)
- `shared.tsx` 的 `<PreBlock>` 增加 `ansi` 开关 — 给其它 renderer(Grep/Read 等)留扩展口子,本期只打开 Bash

**非范围(YAGNI):**

- Bash REPL 实时面板(`splitPane/BashTab.tsx`)— 需要 streaming 解析,单独一档
- 后台 bash 任务卡 — 与对话流 Bash 走同一 renderer,会自动受益;但任何"也改 REPL"的请求不在本期
- 256 / 24-bit 真彩色(`ESC[38;5;…m` / `ESC[38;2;r;g;bm`)— 大多数 build 工具用 16 色够用,避免体积
- 用户切换按钮 / 全局开关
- 非 SGR 控制序列完整支持(`ESC[A` 光标移动、`ESC[2J` 清屏)— 仅做"剥除,不渲染"

## 架构

新增 1 个解析模块、修改 1 个共享组件、修改 1 个 renderer:

| 文件 | 变化 |
|---|---|
| `packages/zai/src/web/src/components/toolRenderers/ansi.tsx` (新) | SGR 解析器 + `<AnsiText>` 组件 → `ReactNode[]` |
| `packages/zai/src/web/src/components/toolRenderers/shared.tsx` | `<PreBlock>` 新增 `ansi?: boolean` |
| `packages/zai/src/web/src/components/toolRenderers/bash.tsx` | `renderOutput` 三处 `<PreBlock>` 加 `ansi`，移除输出侧 `linkifyText` |
| `packages/zai/test/web/toolRenderers/ansi.test.ts` (新) | 8 个核心 case |

**零新增依赖** — 16 色 CSS 调色板硬编码在 `ansi.tsx` 内(VS Code dark theme 风格)。

### 模块边界

**`parseAnsi(text: string): ReactNode[]`**

- 入参:含 ANSI 转义的字符串
- 出参:`ReactNode[]` — `<span style={{...}}>{text}</span>` 数组,纯文本段无包裹
- 不依赖 React 之外的运行时;但 **生成 ReactNode** 需要 React(同一文件内 import)

**`<AnsiText text: string />`**

- 包一层 React 组件,内部走 `parseAnsi`,避免调用方每次 import 函数式
- 放在 `ansi.tsx` 同文件,作为该文件的"对外组件"

**`<PreBlock ansi>`**

- 行为:`ansi=true && typeof children === 'string'` → 走 `<AnsiText>`,否则原样
- 其它 props(variant / 颜色)与现在一致;`<pre>` 容器保持
- **不影响** `renderInput`(Bash 命令)的 `linkifyText` 行为

## 解析器设计

### 支持的 SGR 子集

| 序列 | 行为 |
|---|---|
| `ESC[0m` 或 `ESC[m` | 重置 — 清空样式栈 |
| `ESC[1m` | bold → `fontWeight: 700` |
| `ESC[2m` | dim → `opacity: 0.6` |
| `ESC[3m` | italic → `fontStyle: 'italic'` |
| `ESC[4m` | underline → `textDecoration: 'underline'` |
| `ESC[22m` / `ESC[23m` / `ESC[24m` | 对应属性 unset |
| `ESC[30-37m` / `ESC[90-97m` | 前景 16 色 — 查硬编码 CSS 调色板(见下) |
| `ESC[39m` | 前景 = `inherit` |
| `ESC[40-47m` / `ESC[100-107m` | 背景 16 色 — 查硬编码 CSS 调色板(见下) |
| `ESC[49m` | 背景 = `transparent` |
| 其它 SGR 数字 | 忽略(不报错) |
| 非 SGR CSI(`ESC[A` 光标 / `ESC[2J` 清屏 / `ESC[K` 行尾) | 剥除 |
| OSC(`ESC]…BEL` 或 `ESC]…ESC\\`) | 剥除 |

### 解析策略

**不引入完整状态机**。简化模型:

1. 用一个正则扫出所有控制序列: `/(\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~])/g`
   - 第一支:OSC(terminator BEL 或 ST)
   - 第二支:CSI(`ESC[` 后参数 + 最终字节)
2. 对每个 CSI 切片:判断最终字节是 `m` → SGR 解析;否则(光标等)→ 整体剥除
3. SGR 切片按 `;` 切分;按上面的表逐个更新当前样式对象
4. 控制序列之间的普通文本按当前样式 wrap 成 `<span>`,样式变化时另起一个 span
5. 切片末尾若是 `m` 且样式变空 → 不生成 span,纯文本外露

### 调色板

16 色 CSS 调色板硬编码(VS Code dark theme 风格),不引入 `ansi-styles` 依赖:

```ts
const FG_16: string[] = [
  '#000000', // 30 black
  '#cd3131', // 31 red
  '#0dbc79', // 32 green
  '#e5e510', // 33 yellow
  '#2472c8', // 34 blue
  '#bc3fbc', // 35 magenta
  '#11a8cd', // 36 cyan
  '#e5e5e5', // 37 white
  '#666666', // 90 bright black
  '#f14c4c', // 91 bright red
  '#23d18b', // 92 bright green
  '#f5f543', // 93 bright yellow
  '#3b8eea', // 94 bright blue
  '#d670d6', // 95 bright magenta
  '#29b8db', // 96 bright cyan
  '#e5e5e5', // 97 bright white
]
const BG_16: string[] = [
  '#000000', '#7f0000', '#093b00', '#715c00',
  '#00188a', '#68217a', '#004552', '#a5a5a5',
  '#3d3d3d', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
]
```

SGR 数字 → 索引: `code - 30`(标准)或 `code - 90 + 8`(bright)。BG 同理(`-40` / `-100+8`)。

## 数据流

```
tool_result.payload.output (string, 含 ANSI)
   │
   ▼
parseBashOutput(output)            ← 已有:拆 <stdout>/<stderr>/<plain>
   │   ↓ { stdout, stderr, plain }
   ▼
<PreBlock variant="success" ansi>{stdout}</PreBlock>
   │   ↓
<AnsiText text={stdout} />
   │   ↓
parseAnsi() → ReactNode[]
   │   ↓
[<span style={{color:'#e5e510'}}>npm warn</span>
 <span> config ignoring workspace config at ...</span>
 ...]
   │
   ▼
<pre><span style="...">...</span>...</pre>
```

## API & 错误处理

- `parseAnsi` 永不抛 — 任何异常输入(`ESC` 截断、奇数字节)走"当作普通文本"分支
- `<PreBlock ansi>` 接非 string children 时(如已经是 ReactNode 数组) → 走原样分支,不解析
- 性能:每条 Bash 输出解析一次,典型 < 100KB,远低于 React 渲染开销

## 测试计划

`packages/zai/test/web/toolRenderers/ansi.test.ts`:

1. 纯文本输入 → 输出单文本节点,无 `<span>` 包裹
2. `"\x1b[31mhello\x1b[0m"` → 一个红色 span(`#cd3131`)
3. `"\x1b[1;31mbold red\x1b[0m"` → 复合样式 `fontWeight:700; color:'#cd3131'`
4. `"\x1b[31mred\x1b[0m plain"` → 重置后第二段无颜色
5. `"\x1b[2J"` → 完全剥除,无残留
6. `"\x1b[31m"`(缺 `m`)→ 当普通文本(不抛错,剥除 `\x1b[31` 后续无效)
7. `"\x1b]0;title\x07"`(OSC)→ 剥除
8. 8 种 basic color + bright 都正确

`packages/zai/test/web/toolRenderers/bash.test.ts`(现有):

- 回归测试:`renderOutput` 含 ANSI 时不抛错,渲染出含 `<span style="color:..">` 的 React 树
- snapshot:`stdout` 带 `\x1b[31m` 不再出现 `\x1b` 字面量

## 风险

| 风险 | 缓解 |
|---|---|
| 与 `linkifyText` 在输出文本冲突 | 输出不再 linkify;命令仍 linkify(`renderInput` 路径不变) |
| 切到 `linkify` 兼容导致 XSS | `parseAnsi` 输出走 `<span>{text}</span>`,React 自动 escape |
| 解析器过慢影响首屏 | 解析是同步、纯字符串;Bash 卡片不在 LCP 关键路径 |
| 其它 renderer 误用 `ansi` 开关 | 显式 prop(默认 false),未来谁需要谁打开 |

## 后续(非本期)

- **Bash REPL 实时面板** streaming 解析:同一个 `parseAnsi` 加上 streaming flush(收到每个 chunk 重 parse 当前 buffer,差分输出 ReactNode)
- **后台 bash 任务卡**:复用同一 renderer,自动受益
- **256 / 24-bit 真彩色**:`ESC[38;5;Nm` / `ESC[38;2;R;G;Bm` 路径
- **per-block ANSI/Text 切换**:若用户实际反馈"颜色干扰阅读",再加
