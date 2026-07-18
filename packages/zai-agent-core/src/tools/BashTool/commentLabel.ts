/**
 * 如果 bash 命令首行是 `# comment` (不是 `#!` shebang),
 * 返回剥掉 `#` 的注释文本. 否则返回 undefined。
 *
 * 对标 opencc `tools/BashTool/commentLabel.ts`。
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}