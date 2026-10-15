/**
 * 键盘映射挂在 Lexical 命令层上:菜单仲裁(↑↓/Esc/Enter/Tab)、Enter 提交、
 * 粘贴路由。全部注册在 CRITICAL 优先级,保证先于 @lexical/plain-text 自带
 * 的 Enter / 粘贴默认行为;handler 返回 false 即让位给默认行为
 * (Shift+Enter 换行、普通空格、以及交回给上层的纯文本粘贴)。
 *
 * IME 守卫:组合输入收尾的 Enter / 空格既不能提交也不能仲裁。
 * 三重信号任一成立即认为正在组合:
 * - `KeyboardEvent.isComposing`(Chrome / Edge / Firefox 的原生信号);
 * - `keyCode === 229`(不带 isComposing 时引擎给出的老式信号);
 * - `recentlyComposing()` —— 由上层从 React 的 onCompositionStart/End 维护,
 *   并在 compositionend 后再多守 10ms,覆盖 Safari 把收尾 keydown 派发在
 *   compositionend **之后** 的窗口(旧 textarea 时代验证过的行为)。
 *
 * 这里刻意不监听 Lexical root 元素上的 composition 事件:那层挂载时机
 * 依赖 editor.setRootElement 的回调时序,实测拿不到事件、守卫会静默失效。
 * React 的合成事件挂在同一元素上,可靠且可在测试里直接驱动。
 *
 * 移植自 deepseek-harness `input/editor/keymap.ts`,去掉 claim 的空格
 * 裁决(zi 无 claim 概念)。
 */
import type { LexicalEditor } from 'lexical';
import {
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
} from 'lexical';
import { mergeRegister } from '@lexical/utils';
import type { ArbitrateKey, ArbitrateOutcome } from '../contract.js';

/** 每个被拦截手势背后的、由输入框提供的行为 */
export interface ComposerKeymapHandlers {
  /** 菜单打开期间的键盘仲裁(无候选管线时返回 'pass') */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome;
  /** 关闭弹层(Esc 分层:有浮层先关浮层) */
  dismissPopup(): void;
  /** 此刻是否允许发送(锁定 / 忙碌态拒绝) */
  canSubmit(): boolean;
  /** 普通 Enter 发送;恰好 Ctrl+Enter 或 Cmd+Enter 为加速投递 */
  submit(accelerated: boolean): void;
  /**
   * 剪贴板里带目录元数据的文件。
   * @param files - 浏览器给出的文件(剪贴板序)。
   * @param directories - 已识别的目录成员;无条目判定为目录时缺省。
   */
  intakeFiles(files: readonly File[], directories?: ReadonlySet<File>): void;
  /** 纯文本粘贴(经上层消毒后插入) */
  pasteText(text: string): void;
  /** 上层维护的「刚离开组合输入」窗口(含 Safari 迟到 keydown 的那 10ms) */
  recentlyComposing(): boolean;
}

/** 一次 keydown 可以信任的组合输入状态(见模块头的 Safari 说明) */
function isComposingEvent(event: KeyboardEvent, recentlyComposing: () => boolean): boolean {
  // keyCode 229 是引擎在不带 isComposing 时给出的老式组合输入信号
  return event.isComposing || event.keyCode === 229 || recentlyComposing();
}

/**
 * 在一个编辑器上注册输入框键盘映射。
 * @param editor - 上层持有的编辑器。
 * @param handlers - 输入框提供的行为。
 * @returns 反注册函数。
 */
export function registerComposerKeymap(editor: LexicalEditor, handlers: ComposerKeymapHandlers): () => void {
  const recentlyComposing = handlers.recentlyComposing;

  const arrow = (key: ArbitrateKey) => (event: KeyboardEvent | null): boolean => {
    const inComposition = event !== null && isComposingEvent(event, recentlyComposing);
    if (handlers.arbitrate(key, inComposition) !== 'pass') {
      event?.preventDefault();
      return true;
    }
    return false;
  };

  return mergeRegister(
    editor.registerCommand(KEY_ARROW_UP_COMMAND, arrow('up'), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_DOWN_COMMAND, arrow('down'), COMMAND_PRIORITY_CRITICAL),
    // Tab 落定当前高亮候选;没有候选时放行,保留原生的焦点遍历。
    // Shift+Tab 则像 Esc 一样离开菜单(不论有没有高亮),避免两种 Tab
    // 手势对「是否消费这次按键」的理解打架。
    editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => arrow(event.shiftKey ? 'tabBack' : 'tab')(event),
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        // Esc 分层:有浮层先关浮层;无浮层时不会进一步消费草稿
        handlers.dismissPopup();
        if (handlers.arbitrate('escape', isComposingEvent(event, recentlyComposing)) === 'consumed') {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // 返回 true 会挡掉 Lexical 的兜底换行,但不消费应用快捷键需要的 DOM 事件
        if (
          event !== null &&
          (event.altKey ||
            event.getModifierState('AltGraph') ||
            (event.ctrlKey && event.metaKey) ||
            (event.shiftKey && (event.ctrlKey || event.metaKey)))
        ) {
          return true;
        }
        // 普通 Shift+Enter 保留原生换行,组合输入期间同样如此
        if (event?.shiftKey === true) return false;
        if (event !== null && isComposingEvent(event, recentlyComposing)) {
          // IME 消费了这次 Enter(选候选):既不提交也不换行。
          // 不 preventDefault —— 这个手势归浏览器。
          return true;
        }
        // 菜单打开时 Enter 选高亮项;无高亮则放行到提交手势
        if (handlers.arbitrate('enter', false) !== 'pass') {
          event?.preventDefault();
          return true;
        }
        event?.preventDefault();
        if (event?.repeat === true) return true; // 长按 Enter 不能连发
        if (!handlers.canSubmit()) return true;
        handlers.submit(event?.ctrlKey === true || event?.metaKey === true);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        // 鸭子类型:payload 联合里有 InputEvent,测试引擎也会把
        // clipboardData 挂在普通事件上
        const clipboardData = (event as ClipboardEvent).clipboardData ?? null;
        if (clipboardData === null) return false;
        const files: File[] = [];
        const directories = new Set<File>();
        for (const item of clipboardData.items) {
          if (item.kind !== 'file') continue;
          const file = item.getAsFile();
          if (file === null) continue;
          files.push(file);
          if (typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory === true) {
            directories.add(file);
          }
        }
        if (files.length > 0) {
          handlers.intakeFiles(files, directories.size === 0 ? undefined : directories);
        }
        const text = clipboardData.getData('text/plain');
        if (text === '') {
          if (files.length === 0) return false;
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        handlers.pasteText(text);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
}