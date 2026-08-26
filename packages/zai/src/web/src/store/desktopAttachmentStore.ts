import { create } from 'zustand';
import type { FileRef } from '../components/desktop/gatherMentions.js';
import { gatherMentions } from '../components/desktop/gatherMentions.js';

/**
 * 桌面附件区跨组件共享 store。
 *
 * 背景:附件区 refs 原本是 Desktop.tsx 的局部 state,AgentInputBox 提交时
 * 拿不到 —— AI 对拖进来的附件完全无感知,只能靠用户手动点「并入输入框」。
 * 现在 refs 收敛到此处,发送方(AgentInputBox.handleSend)在桌面页下自动
 * 取未并入的附件并入 prompt。
 *
 * 「仅并入一次」语义(2026-08-26 产品确认):
 * - takeUnmergedMentions 返回未 merged 附件的 @mention 追加文本,并把它们
 *   标记为 merged —— 同路径附件只自动附带一次,附件区保留(用户继续可见)。
 * - 手动移除附件(removeRef)会解除 merged 标记,再次拖入可重新并入。
 * - 「并入输入框」手动路径成功后 markAllMerged,避免与自动并入双重附带。
 */
interface DesktopAttachmentState {
  refs: FileRef[];
  /** 已自动并入过 prompt 的附件 id(同路径仅并入一次;手动移除后解除) */
  mergedIds: string[];
  addRef: (r: FileRef) => void;
  removeRef: (id: string) => void;
  markAllMerged: () => void;
  /**
   * 发送时调用:取未并入的附件,生成追加 mention 文本(draft 中已有的
   * @path 会被 gatherMentions 去重),并把它们标记为已并入。
   * 返回 '' 表示无需附带。
   */
  takeUnmergedMentions: (draft: string) => string;
}

export const useDesktopAttachmentStore = create<DesktopAttachmentState>()((set, get) => ({
  refs: [],
  mergedIds: [],

  addRef: (r) =>
    set((s) => {
      if (s.refs.some((x) => x.id === r.id)) return s;
      // 重新拖入(此前被移除)视为新附件:解除 merged,允许再次自动并入
      return {
        refs: [...s.refs, r],
        mergedIds: s.mergedIds.filter((id) => id !== r.id),
      };
    }),

  removeRef: (id) =>
    set((s) => ({
      refs: s.refs.filter((r) => r.id !== id),
      mergedIds: s.mergedIds.filter((x) => x !== id),
    })),

  markAllMerged: () =>
    set((s) => ({
      mergedIds: Array.from(new Set([...s.mergedIds, ...s.refs.map((r) => r.id)])),
    })),

  takeUnmergedMentions: (draft) => {
    const { refs, mergedIds } = get();
    const unmerged = refs.filter((r) => !mergedIds.includes(r.id));
    if (unmerged.length === 0) return '';
    // gatherMentions 内部按 formatFileMention 去重 + 过滤 draft 已含的引用
    const text = gatherMentions(unmerged, draft);
    // 无论是否因去重而没有输出,本次发送都消耗了这批附件(仅并入一次)
    set((s) => ({
      mergedIds: Array.from(new Set([...s.mergedIds, ...unmerged.map((r) => r.id)])),
    }));
    return text;
  },
}));