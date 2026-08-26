/**
 * stdout NDJSON 行解析器。逐行 readline 迭代,天然背压(消费者不 pull 时
 * Node readline 会暂停底层流);对 EOF / 空行 / 非法 JSON 行做容错。
 *
 * vendor `--output-format stream-json` 保证 stdout 每行一个 JSON 对象,
 * 但防御性解析避免一行坏数据打挂整条宿主链路。
 */

import { createInterface } from 'node:readline'

export async function* parseNdjson(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<unknown> {
  const rl = createInterface({
    input: stream as unknown as NodeJS.ReadableStream,
    crlfDelay: Infinity,
    terminal: false,
  })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      yield JSON.parse(trimmed)
    } catch {
      console.warn(
        `[sessionHost:ndjson] 忽略非法 JSON 行: ${trimmed.slice(0, 160)}`,
      )
    }
  }
}