/**
 * ReferenceChipNode — 输入框里的一个文件引用,作为 Lexical 原子装饰节点。
 *
 * 节点本身**就是**这次引用:NodeKey 承载身份,节点上缓存插入时的投影
 * (label / clipboardText / invalid),`getTextContent()` 回答剪贴板与持久化
 * 投影,detect 投影里它只占 1 个 U+FFFC(见 projection.ts)。
 *
 * 关键收益:chip 是真实的行内元素,宽度随 label 自然撑开 —— 这是旧
 * textarea + backdrop 方案做不到的(那边 chip 宽度被 U+FFFC 占位单元锁死,
 * 长文件名必然被截断)。
 */
import type { JSX } from 'react';
import { DecoratorNode } from 'lexical';
import type { EditorConfig, LexicalNode, NodeKey, SerializedLexicalNode, Spread } from 'lexical';
import MentionChip from '../../MentionChip.js';
import type { ReferenceInsert } from '../contract.js';

/** 一个 chip 的 JSON 序列化形状(Lexical 节点契约) */
export type SerializedReferenceChipNode = Spread<{
  source: string;
  ref: string;
  label: string;
  clipboardText: string;
  invalid: boolean;
}, SerializedLexicalNode>;

/** 一次文件引用占位,作为原子装饰节点存在 */
export class ReferenceChipNode extends DecoratorNode<JSX.Element> {
  /** 来源名(序列化路由键) */
  __source: string;
  /** 引用 id(相对路径,目录以 `/` 结尾) */
  __ref: string;
  /** 行内展示 label */
  __label: string;
  /** 剪贴板 / 持久化投影(如 `@src/foo.ts`) */
  __clipboardText: string;
  /** 引用失效位:置灰渲染 */
  __invalid: boolean;

  /** Lexical 节点注册类型标签 */
  static override getType(): string {
    return 'reference-chip';
  }

  /**
   * 带身份克隆(Lexical 可写副本契约)。
   * @param node - 待克隆节点。
   * @returns 携带同一 NodeKey 的副本。
   */
  static override clone(node: ReferenceChipNode): ReferenceChipNode {
    return new ReferenceChipNode(
      {
        source: node.__source,
        ref: node.__ref,
        label: node.__label,
        clipboardText: node.__clipboardText,
      },
      node.__invalid,
      node.__key,
    );
  }

  /**
   * 从 JSON 形态重建。
   * @param json - 序列化后的 chip。
   * @returns 新键的节点。
   */
  static override importJSON(json: SerializedReferenceChipNode): ReferenceChipNode {
    return new ReferenceChipNode(
      {
        source: json.source,
        ref: json.ref,
        label: json.label,
        clipboardText: json.clipboardText,
      },
      json.invalid,
    );
  }

  /**
   * @param insert - 插入时的引用投影。
   * @param invalid - 引用失效位(默认有效)。
   * @param key - Lexical 克隆路径键;新建节点时不传。
   */
  constructor(insert: ReferenceInsert, invalid = false, key?: NodeKey) {
    super(key);
    this.__source = insert.source;
    this.__ref = insert.ref;
    this.__label = insert.label;
    this.__clipboardText = insert.clipboardText;
    this.__invalid = invalid;
  }

  /** 序列化为 JSON 节点形态。 */
  override exportJSON(): SerializedReferenceChipNode {
    return {
      ...super.exportJSON(),
      type: 'reference-chip',
      version: 1,
      source: this.__source,
      ref: this.__ref,
      label: this.__label,
      clipboardText: this.__clipboardText,
      invalid: this.__invalid,
    };
  }

  /**
   * 挂载 chip 的宿主元素;React 装饰面由 DecoratorPortals portal 进去。
   * @returns 行内、不可编辑的 span,带测试 / e2e 锚点。
   */
  override createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('span');
    el.setAttribute('data-composer-chip', this.__source);
    el.setAttribute('contenteditable', 'false');
    return el;
  }

  /** 宿主元素形状永不变化。 */
  override updateDOM(): boolean {
    return false;
  }

  /** chip 就在文本行里。 */
  override isInline(): boolean {
    return true;
  }

  /**
   * 不存在「键盘选中」的中间态:方向键一步跨过整个 chip,Backspace /
   * Delete 一次删净(旧 textarea 占位符的语义)。返回 true 会在按键与
   * 光标之间插入一个 NodeSelection —— 而纯文本绑定的各 handler 全部
   * 忽略这个状态,会让 chip 边缘的方向键、输入、删除全部死锁。
   */
  override isKeyboardSelectable(): boolean {
    return false;
  }

  /** 剪贴板 / 持久化投影(原生复制走这里)。 */
  override getTextContent(): string {
    return this.__clipboardText;
  }

  /**
   * 翻转失效位。
   * @param invalid - 下一状态;调用方负责判断是否是 no-op。
   */
  setInvalid(invalid: boolean): void {
    const writable = this.getWritable();
    writable.__invalid = invalid;
  }

  /** 失效位。 */
  isInvalid(): boolean {
    return this.getLatest().__invalid;
  }

  /** 来源名。 */
  getSource(): string {
    return this.getLatest().__source;
  }

  /** 引用 id。 */
  getReference(): string {
    return this.getLatest().__ref;
  }

  /** 展示 label。 */
  getLabel(): string {
    return this.getLatest().__label;
  }

  /** 装饰面 React 组件,由 portal 渲染进宿主元素。 */
  override decorate(): JSX.Element {
    return (
      <MentionChip
        data={{ path: this.__ref, label: this.__label, invalid: this.__invalid }}
        onMouseDown={(e) => {
          // chip 不可编辑,但点击不应把焦点从输入框带走(combo 模式约束)
          e.preventDefault();
        }}
      />
    );
  }
}

/**
 * 从一次引用插入铸造 chip 节点。
 * @param insert - 引用投影。
 * @returns 新节点。
 */
export function $createReferenceChipNode(insert: ReferenceInsert): ReferenceChipNode {
  return new ReferenceChipNode(insert);
}

/**
 * chip 类型守卫。
 * @param node - 任意节点或空值。
 * @returns 是否为 ReferenceChipNode。
 */
export function $isReferenceChipNode(node: LexicalNode | null | undefined): node is ReferenceChipNode {
  return node instanceof ReferenceChipNode;
}