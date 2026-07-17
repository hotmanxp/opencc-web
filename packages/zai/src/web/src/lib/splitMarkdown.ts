/**
 * 把 markdown 文本切成 [complete, tail]：
 * - complete 是"已完整闭合"的全部内容, 可安全丢给 react-markdown 渲染
 * - tail 是末尾可能未闭合的尾巴, 按 pre-wrap 渲染 (避免出现半截 fence / 半截加粗导致 UI 跳变)
 *
 * 切点规则:
 * 1. 若当前仍处于已开未闭的 fenced code block, 切点为该开启围栏所在行首 ——
 *    围栏内可能含 \n\n, 不能用 \n\n 判定段落边界, 所以先判围栏状态.
 * 2. 否则, 找最后一个 \n\n (段落分隔), 切在该 \n\n 之后.
 * 3. 兜底: 整段归 tail.
 */
export function splitMarkdownOnIncomplete(
  text: string,
): { complete: string; tail: string } {
  if (!text) return { complete: '', tail: '' }

  // 1) 检查是否处于未闭合 fenced code block
  const { fenceStart: openPos, fenceEnd, fenceOpened } = findOpenFenceStart(text)

  if (openPos !== -1) {
    // 仍在未闭围栏中
    if (fenceEnd >= 0) {
      // 有关闭围栏位置, 包含完整的关闭行
      const afterClose = text.indexOf('\n', fenceEnd)
      const closeLineEnd = afterClose === -1 ? text.length : afterClose + 1
      return {
        complete: text.slice(0, closeLineEnd),
        tail: text.slice(closeLineEnd),
      }
    }
    // tail 从围栏起始位置开始
    return { complete: text.slice(0, openPos), tail: text.slice(openPos) }
  }

  // 2) 所有围栏均已闭合 (或从未有围栏)
  const lastBlank = text.lastIndexOf('\n\n')
  if (lastBlank === -1) {
    // 无段落分隔符
    if (fenceEnd >= 0) {
      const afterClose = text.indexOf('\n', fenceEnd)
      const closeLineEnd = afterClose === -1 ? text.length : afterClose + 1
      if (closeLineEnd < text.length) {
        // 有内容紧随关闭行, split at fence close line
        return {
          complete: text.slice(0, closeLineEnd),
          tail: text.slice(closeLineEnd),
        }
      }
      return { complete: text, tail: '' }
    }
    return { complete: '', tail: text }
  }

  // 有段落分隔符, fenceEnd 是围栏关闭行首位置
  const closePos = fenceEnd >= 0 ? fenceEnd : -1

  // 检查 lastBlank 是否在围栏关闭行之后
  if (closePos >= lastBlank) {
    // lastBlank 在围栏关闭行或之前, 围栏本身完整, 整个 text 都是 complete
    return { complete: text, tail: '' }
  }

  // 正常按 \n\n 切分
  return {
    complete: text.slice(0, lastBlank + 2),
    tail: text.slice(lastBlank + 2),
  }
}

/**
 * 行扫描 fenced code block 开闭状态.
 * 开启: 行匹配 /^\s*\`{3,}\S.*$/ (有 info string, 如 ```python)
 *      或行匹配 /^\s*\`{3,}\s*$/ (无 info string 的 bare ```)
 * 闭合: 行匹配 /^\s*\`{3,}\s*$/ (无 info string, marker 长度 >= 开启长度)
 *
 * 返回:
 * - fenceStart: 已开未闭的开启围栏行首位置; 若均闭合则为 -1
 * - fenceEnd: 最后一个围栏关闭行首位置 (若关闭后有内容跟随时仍记录)
 * - fenceOpened: 是否曾打开过围栏
 */
function findOpenFenceStart(
  text: string,
): { fenceStart: number; fenceEnd: number; fenceOpened: boolean } {
  // 匹配一行: 可选前置空白 + 3+ 反引号 + 可选语言 (开启), 或仅 3+ 反引号 (闭合)
  const fenceLine = /^(\s*)(`{3,})(\s*\S*)\s*$/

  let cursor = 0
  let openPos = -1
  let openMarkerLen = 0
  let fenceOpened = false
  let fenceEnd = -1

  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(cursor, lineEnd)

    const m = fenceLine.exec(line)
    if (m) {
      const indent = m[1] ?? ''
      const marker = m[2] ?? ''
      const rest = (m[3] ?? '').trim()
      if (openPos === -1) {
        // 围栏开启: 有 info string, 或 bare ``` (无 info string 但可作为开启)
        if (rest.length > 0 || marker.length >= 3) {
          openPos = cursor + indent.length
          openMarkerLen = marker.length
          fenceOpened = true
        }
      } else {
        // Close: no info string, marker length >= opening
        if (marker.length >= openMarkerLen && rest.length === 0) {
          fenceEnd = cursor
          openPos = -1
          openMarkerLen = 0
        }
      }
    }

    if (nl === -1) break
    cursor = nl + 1
  }

  return { fenceStart: openPos, fenceEnd, fenceOpened }
}
