# Agent 流式 Markdown 渲染设计

- 日期：2026-07-17
- 范围：`packages/zai/src/web/src/pages/Agent.tsx`
- 目标：流式输出过程中，已闭合的 markdown 块立即渲染为结构化 HTML，未闭合的尾巴仍按 pre-wrap 显示；不再等到完整 `` ``` `` 围栏才渲染。

## 需求

`Agent.tsx:735-783` 的 `MessageBubble` 当前实现：

```tsx
{streaming ? (
  <div style={{ whiteSpace: 'pre-wrap', /* … */ }}>
    {linkifyText(text)}
    <span /* blink cursor */ />
  </div>
) : (
  <MarkdownText text={text} />
)}
```

注释明确写出原因："流式期间跳过 ReactMarkdown 重解析（每次 delta 都跑一次 unified pipeline 太重），用 pre-wrap 渲染纯文本；状态切回 idle 后才解析 markdown"。

副作用：用户在 LLM 流式期间看到的是带反引号、`**`、井号等字面字符的源码。例如：

```text
下面是一个示例:

```python
def foo():
    return 1
```

执行结果:
```

整段回复都是字面源码，要等 SSE `runtime.done` 触发 React 重渲才会突然切换为标题 / 列表 / 代码块结构。视觉跳变明显，长回复（数千字）期间完全无法识别 Markdown 结构，体验割裂。

**期望**：在流式过程中，已经"完整闭合"的 markdown 块（以 `\n\n` 收尾的段落、已闭合的代码围栏、完整列表 / 标题等）立刻按 Markdown 渲染；仅把可能未闭合的尾巴保留为 pre-wrap。光标始终跟随尾巴末尾。

## 方案

仅替换 `Agent.tsx` 的流式分支渲染逻辑，不改 SSE / store / 后端。

### 1. 新增纯函数 `splitMarkdownOnIncomplete`

位置：`packages/zai/src/web/src/lib/splitMarkdown.ts`（与 `linkify.tsx` 同级）。

签名：

```ts
export function splitMarkdownOnIncomplete(
  text: string,
): { complete: string; tail: string }
```

**算法**：

1. 行扫描，统计 fenced code block 开闭状态（行匹配 `/^\s*`{3,}\w*\s*$/` 视为开启，行匹配 `/^\s*`{3,}\s*$/` 视为闭合，闭合标记长度 ≥ 开启标记长度）。
2. 若当前仍处于"已开未闭"状态 → 切点为该开启围栏所在行首位置 `fenceOpenPos`：
   - `complete = text.slice(0, fenceOpenPos)`
   - `tail = text.slice(fenceOpenPos)`（含开启围栏到末尾，全部按 pre-wrap）
3. 否则（不在未闭合代码块内）：从末尾往前找最后一个 `\n\n` 双换行位置 `lastBlank`：
   - `complete = text.slice(0, lastBlank + 2)`（含双换行，便于后续块保持空行分隔）
   - `tail = text.slice(lastBlank + 2)`
4. 兜底：找不到 `\n\n` 也无未闭合围栏 → `complete = ''`, `tail = text`。

**复杂度**：O(n)，单次字符串扫描，无 AST / parser 开销。

**为什么这样选**：满足"只渲染完整块"的诉求；性能远低于 unified pipeline；实现简单，行为可预测；与现有 react-markdown 渲染路径不冲突。

### 2. 新增组件 `StreamingMarkdown`

位置：`packages/zai/src/web/src/pages/Agent.tsx` 内（与 `MarkdownText` 同文件，复用 `markdownComponents`）。

```tsx
function StreamingMarkdown({ text }: { text: string }) {
  const { complete, tail } = useMemo(
    () => splitMarkdownOnIncomplete(text),
    [text],
  );
  return (
    <>
      {complete && <MarkdownText text={complete} />}
      {tail && (
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'inherit',
          }}
        >
          {linkifyText(tail)}
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 14,
              verticalAlign: '-2px',
              marginLeft: 2,
              background: '#1677ff',
              animation: 'zai-blink 1s steps(1) infinite',
            }}
          />
        </div>
      )}
    </>
  );
}
```

- `complete` 与 `tail` 用 `useMemo` 缓存（text 变化时自然失效）
- 光标始终在 `tail` 末尾，样式与现有 `Agent.tsx:770-779` 完全一致
- 流式结束后 (`streaming === false`) 仍然走 `<MarkdownText text={text} />` 整段路径——与流式最终态视觉一致

### 3. 替换流式分支

`Agent.tsx:758-783` 的 `<div style={{ whiteSpace: 'pre-wrap' }}>{linkifyText(text)}<span /* cursor */ /></div>` 整段替换为 `<StreamingMarkdown text={text} />`。

`MarkdownText` 组件、`markdownComponents`、`linkifyText`、blink 样式 keyframes（`zai-blink` 在 `index.css`）全部保持不变。

## 数据流与边界

| 场景 | 输入 text | complete | tail |
|------|-----------|----------|------|
| 空文本 | `''` | `''` | `''` |
| 单段未结束 | `'Hello **bold' ` | `''` | `'Hello **bold' ` |
| 单段以 `\n\n` 结尾 | `'Hello\n\n'` | `'Hello\n\n'` | `''` |
| 多段，最后段未结束 | `'A\n\nB '` | `'A\n\n'` | `'B '` |
| 完整闭合围栏 | `` "```py\nx\n```" `` | `` "```py\nx\n```" `` | `''` |
| 未闭合围栏 | `` "```py\nx\n" `` | `''` | `` "```py\nx\n" `` |
| 闭合围栏 + 后续未完 prose | `` "```py\nx\n```\nMore" `` | `` "```py\nx\n```\n" `` | `'More'` |
| 4 个反引号围栏 | `` "````md\n````" `` | 同 complete | `''` |

**不变**：
- SSE 数据流 / event schema
- `useAgentStore` reducer
- `MessageBubble` props / 调用方
- `MarkdownText`、`markdownComponents`、`linkifyText`
- `index.css` 中 `zai-blink` keyframes
- `TaskDrawer.tsx`（无流式场景，沿用现有 MarkdownText 整段渲染）

**新行为**：
- 流式期间，已闭合的 markdown 块立即按 `MarkdownText` 渲染
- 仅可能未闭合的尾巴仍以 pre-wrap 显示，光标紧随其后
- 视觉切换点：完整块到达瞬间从纯文本切换为结构化 HTML，UI 重排但不闪动（React 复用 keyed 节点）

## 测试与验收

新增 `packages/zai/src/web/src/lib/splitMarkdown.test.ts`：

1. **空字符串** → `complete=''`, `tail=''`
2. **无 `\n\n` 单段** → `complete=''`, `tail` = 全文
3. **以 `\n\n` 结尾的段落** → `complete` 含 `\n\n`, `tail=''`
4. **多段（中间含 `\n\n`）** → `complete` 到最后一个 `\n\n` 之后，`tail` = 最后段
5. **完整闭合围栏（无语言）** → `complete` = 围栏整段, `tail=''`
6. **完整闭合围栏（带语言 `\`\`\`python`）** → 同上
7. **未闭合围栏** → `complete=''`, `tail` = 含围栏到末尾
8. **已闭合围栏 + 后续未完 prose** → `complete` 含围栏 + 尾随 `\n`, `tail` = 后续 prose
9. **4 个反引号围栏** → 视为开启/闭合标记，`{3,}` 量词支持
10. **围栏内含 `\n\n`** → 不应误判为段落结束（`\n\n` 扫描只在"非围栏内"才有效）

执行命令：

```bash
cd packages/zai && npm test -- splitMarkdown
cd packages/zai && npm run typecheck
cd packages/zai && npm run build
```

**手动验收**：

1. 启动 dev server，发起一段包含 `# 标题` / `- 列表` / `` ```python `` / `**bold**` / 表格的 prompt
2. 观察流式过程中：标题、列表、已闭合代码块立即按结构化渲染；最后一段未闭合的纯文本 + 光标正常
3. 流式结束 → 整段 MD 渲染，与流式最终态视觉一致
4. 切到 transcript 回放（侧栏历史）→ 仍是 `<MarkdownText text={text} />` 整段渲染，不变

## 非目标

- 不在流式期尝试渲染 inline 语法（如段内 `**bold**` 闭合即加粗）—— 留作后续可选增强
- 不改 SSE 数据模型 / 后端
- 不做节流 / debounce（每次 delta 一次字符串扫描已足够便宜）
- 不抽出共享 `markdownComponents` 模块（YAGNI；本次仍只在一处使用）
- 不修改 TaskDrawer.tsx（无流式）
- 不修改 transcript 历史回放路径（已经走 `<MarkdownText>` 整段）
- 不为围栏内 `\n\n` 单独做更细的状态机—— 通过"先判围栏状态再扫段落边界"自然回避