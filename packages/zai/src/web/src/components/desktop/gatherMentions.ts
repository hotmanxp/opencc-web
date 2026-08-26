import { formatFileMention } from '../mentionGrammar.js';

export interface FileRef {
  id: string;
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

/** 附件 → 追加进 prompt 的 @mention 文本。draft 已含同路径(按 mention 字符串)
 *  时跳过;返回 '' 表示无需追加。control 字符/坏路径(格式化为 undefined)跳过。 */
export function gatherMentions(refs: FileRef[], draft: string): string {
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const fmt = formatFileMention({ path: r.path, kind: r.kind }, false);
    if (fmt === undefined) continue;               // 控制字符/双引号 → 拒绝
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    if (draft.includes(fmt)) continue;             // 已在原文 → 去重
    mentions.push(fmt);
  }
  if (mentions.length === 0) return '';
  return (draft.length > 0 ? '\n' : '') + mentions.join(' ');
}
