/**
 * 激活 token 高亮:当前正在补全的那段文本(leading `/命令` 或光标处的
 * `@token`)在输入框内染成 `--cmd-token-color`,与下拉里的 `/name`、`@候选`
 * 同一颜色,让用户在按下 Enter/Tab 之前就确认「我现在选中的是哪个」。
 *
 * 一个 TextNode transform 保证 token 独占带样式的节点(在 token 边界打字
 * 会触发拆分);上层在 token 变化时把相关叶节点标脏,进出激活态不需要
 * 靠一次文本编辑触发重绘。
 *
 * 手法移植自 deepseek-harness `input/editor/claim-decor.ts`(zai 没有 claim,
 * 换成 slash / @ 两类 token,且 token 不一定在文档开头)。
 */
import type { LexicalEditor, TextNode as TextNodeType } from 'lexical';
import { $getRoot, $isElementNode, $isTextNode, TextNode } from 'lexical';
import { $composerLayout } from './projection.js';

/** token 节点携带的行内样式 */
const TOKEN_STYLE = 'color: var(--cmd-token-color)';

/** detect 坐标下的 token 区间(上层每帧重算) */
export interface TokenSpan {
  readonly start: number;
  readonly end: number;
}

/** 把整段文本标脏:激活态变化但内容没变时,transform 需要被重新触发 */
function markTokenDirty(editor: LexicalEditor): void {
  // 非离散:刷新可能从 update listener 内部发起,同步嵌套提交会递归
  editor.update(() => {
    const root = $getRoot();
    const walk = (element: ReturnType<typeof $getRoot>): void => {
      for (const child of element.getChildren()) {
        if ($isTextNode(child)) child.markDirty();
        else if ($isElementNode(child)) walk(child);
      }
    };
    walk(root);
  }, { tag: 'token-decor-refresh' });
}

/**
 * 注册激活 token 的样式 transform。
 * @param editor - 上层持有的编辑器。
 * @param activeSpan - 实时读取当前激活 token 区间;无激活 token 时为 null。
 * @returns 反注册函数。
 */
export function registerTokenDecoration(
  editor: LexicalEditor,
  activeSpan: () => TokenSpan | null,
): () => void {
  return editor.registerNodeTransform(TextNode, (node) => {
    const span = activeSpan();
    const styled = node.getStyle() === TOKEN_STYLE;
    if (span === null) {
      // 没有激活 token:清掉可能残留的样式(段落合并会把节点挪到这里)
      if (styled) node.setStyle('');
      return;
    }
    const segment = $composerLayout().byKey.get(node.getKey());
    if (segment === undefined || segment.kind !== 'text') {
      if (styled) node.setStyle('');
      return;
    }
    const text = node.getTextContent();
    const from = span.start - segment.detectStart;
    const to = span.end - segment.detectStart;
    // token 不完整落在这个节点里(跨节点 / 已越界):本节点无样式
    if (from < 0 || to > text.length || to <= from) {
      if (styled) node.setStyle('');
      return;
    }
    if (text.length === to - from) {
      if (!styled) node.setStyle(TOKEN_STYLE);
      return;
    }
    if (from > 0) {
      // 先把 token 之前的部分拆出去:新节点各自标脏后会重跑本 transform,
      // 文本长度严格递减,必然收敛(Unlike dsh 的 claim 版本,这里的 token
      // 可能落在文档任意位置,不能只处理首叶)。
      const [head, rest] = node.splitText(from);
      head.setStyle('');
      if (rest !== undefined) rest.setStyle(TOKEN_STYLE);
      return;
    }
    // token 从本节点开头开始:把 token 之后的尾巴拆出去
    const [tokenNode, tail] = node.splitText(to - from);
    tokenNode.setStyle(TOKEN_STYLE);
    if (tail !== undefined) tail.setStyle('');
  });
}

/**
 * 把所有文本叶节点标脏,让 transform 在激活 token 变化后重绘
 * (token 的出现/消失不伴随文本编辑,而 transform 只跑在被标脏的节点上)。
 * @param editor - 上层持有的编辑器。
 */
export function refreshTokenDecoration(editor: LexicalEditor): void {
  markTokenDirty(editor);
}