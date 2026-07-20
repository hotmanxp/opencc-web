import type { AnthropicMessage, ContentBlock, TranscriptMessage } from './types.js'
import type { TranscriptStore } from './store.js'

export type TranscriptRepairReport = {
  repaired: boolean
  repairedToolUseIds: string[]
  synthesizedToolUseIds: string[]
  synthesizedOrphanToolUseIds: string[]
  droppedMessageUuids: string[]
}

export type TranscriptRepairResult = {
  messages: TranscriptMessage[]
  report: TranscriptRepairReport
}

type ToolUseBlock = ContentBlock & { type: 'tool_use'; id: string }
type ToolResultBlock = ContentBlock & { type: 'tool_result'; tool_use_id: string }

const RECOVERY_TEXT = 'Transcript repair: tool execution did not complete.'

const blocks = (message: TranscriptMessage): ContentBlock[] => {
  const content = message.message?.content
  return Array.isArray(content) ? content : []
}

const toolUses = (message: TranscriptMessage): ToolUseBlock[] =>
  blocks(message).filter((block): block is ToolUseBlock =>
    block.type === 'tool_use' && typeof block.id === 'string')

const toolResults = (message: TranscriptMessage): ToolResultBlock[] =>
  blocks(message).filter((block): block is ToolResultBlock =>
    block.type === 'tool_result' && typeof block.tool_use_id === 'string')

const isPureToolResult = (message: TranscriptMessage): boolean => {
  const content = message.message?.content
  return Array.isArray(content)
    && content.length > 0
    && content.every(block => block.type === 'tool_result')
}

const latest = (messages: TranscriptMessage[]): TranscriptMessage | undefined => {
  let candidate: TranscriptMessage | undefined
  for (const message of messages) {
    if (!candidate || message.timestamp >= candidate.timestamp) candidate = message
  }
  return candidate
}

const clone = (message: TranscriptMessage): TranscriptMessage => structuredClone(message)

const stable = (value: unknown): string => JSON.stringify(value)

const validProtocol = (messages: TranscriptMessage[]): boolean => {
  for (let index = 0; index < messages.length; index += 1) {
    const results = toolResults(messages[index])
    if (results.length === 0) continue

    // Walk back through consecutive `tool_use` records so parallel
    // tool_use/result pairs that share a single user result record all
    // resolve. Stop the walk at the first non-tool_use message and bail
    // out if we never found any preceding tool_use records.
    const ids = new Set<string>()
    let cursor = index - 1
    while (cursor >= 0 && messages[cursor].type === 'tool_use') {
      for (const block of toolUses(messages[cursor])) ids.add(block.id)
      cursor -= 1
    }
    if (ids.size === 0) return false
    if (results.some(block => !ids.has(block.tool_use_id))) return false
  }
  return true
}

const recoveryRecord = (
  tool: TranscriptMessage,
  toolUseId: string,
  ordinal: number,
): TranscriptMessage => {
  const message: AnthropicMessage = {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: RECOVERY_TEXT,
      is_error: true,
    }],
  }
  return {
    ...clone(tool),
    uuid: `${tool.uuid}-repair-${ordinal}`,
    parentUuid: tool.uuid,
    type: 'user',
    timestamp: tool.timestamp,
    raw: null,
    message,
  }
}

export function repairTranscriptToolPairs(
  messages: TranscriptMessage[],
): TranscriptRepairResult {
  const original = messages.map(clone)
  const originalIndex = new Map(messages.map((message, index) => [message.uuid, index]))
  const byUuid = new Map(messages.map(message => [message.uuid, message]))
  const childrenByParent = new Map<string, TranscriptMessage[]>()
  const toolUsesById = new Map<string, TranscriptMessage>()
  const resultsByToolUseId = new Map<string, ToolResultBlock[]>()

  for (const message of messages) {
    if (message.parentUuid) {
      const children = childrenByParent.get(message.parentUuid) ?? []
      children.push(message)
      childrenByParent.set(message.parentUuid, children)
    }
    for (const block of toolUses(message)) toolUsesById.set(block.id, message)
    for (const block of toolResults(message)) {
      const results = resultsByToolUseId.get(block.tool_use_id) ?? []
      results.push(structuredClone(block))
      resultsByToolUseId.set(block.tool_use_id, results)
    }
  }

  const pureResultUuids = new Set(messages.filter(isPureToolResult).map(message => message.uuid))
  const activeLeaf = latest(messages.filter(message => !pureResultUuids.has(message.uuid))) ?? latest(messages)
  const chain: TranscriptMessage[] = []
  const chainUuids = new Set<string>()
  const seen = new Set<string>()
  let cursor = activeLeaf
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid)
    chain.push(cursor)
    chainUuids.add(cursor.uuid)
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined
  }
  chain.reverse()

  // ---- orphan revival (spec §6a) ---------------------------------------
  // Orphan tool_use records have either:
  //   - parentUuid not on the active chain, or
  //   - parentUuid on the chain but parent's type !== 'assistant'.
  // We re-attach each orphan to the most recent active-chain assistant that
  // appears in source-array order before the orphan. The orphan's tool_use
  // id is added to `synthesizedOrphanToolUseIds`; downstream §4-6 logic
  // synthesizes the recovery result.
  const revivedAnchors = new Map<string, TranscriptMessage[]>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.type !== 'tool_use') continue
    const parent = message.parentUuid ? byUuid.get(message.parentUuid) : undefined
    const parentOnChain = message.parentUuid ? chainUuids.has(message.parentUuid) : false
    const parentIsAssistant = parent?.type === 'assistant'
    if (parentOnChain && parentIsAssistant) continue

    // No anchor available when there's no assistant earlier than this
    // orphan on the active chain.
    const anchor = [...chain]
      .reverse()
      .find(candidate => candidate.type === 'assistant' && (originalIndex.get(candidate.uuid) ?? 0) < index)
    if (!anchor) {
      return {
        messages: original,
        report: {
          repaired: false,
          repairedToolUseIds: [],
          synthesizedToolUseIds: [],
          synthesizedOrphanToolUseIds: [],
          droppedMessageUuids: [],
        },
      }
    }
    const list = revivedAnchors.get(anchor.uuid) ?? []
    list.push(message)
    revivedAnchors.set(anchor.uuid, list)
  }

  const resultUuids = new Set(messages
    .filter(message => toolResults(message).length > 0)
    .map(message => message.uuid))
  const originalResultUuids = new Set(pureResultUuids)
  const originalResultRecords = messages.filter(isPureToolResult)
  const output: TranscriptMessage[] = []
  const emitted = new Set<string>()
  const repairedToolUseIds: string[] = []
  const synthesizedToolUseIds: string[] = []
  const synthesizedOrphanToolUseIds: string[] = []

  for (const message of chain) {
    if (
      message.type === 'tool_use'
      || pureResultUuids.has(message.uuid)
      || emitted.has(message.uuid)
      || resultUuids.has(message.uuid)
    ) continue
    output.push(clone(message))
    emitted.add(message.uuid)
    if (message.type !== 'assistant') continue

    const children = [
      ...(childrenByParent.get(message.uuid) ?? []),
      ...(revivedAnchors.get(message.uuid) ?? []),
    ]
      .filter(child => child.type === 'tool_use')
      .sort((left, right) => (originalIndex.get(left.uuid) ?? 0) - (originalIndex.get(right.uuid) ?? 0))
    const groupedResults: ToolResultBlock[] = []
    let lastTool: TranscriptMessage | undefined
    for (const child of children) {
      output.push(clone(child))
      emitted.add(child.uuid)
      lastTool = child
      const revivedFromHere = (revivedAnchors.get(message.uuid) ?? []).some(candidate => candidate.uuid === child.uuid)
      for (const block of toolUses(child)) {
        const results = resultsByToolUseId.get(block.id)
        if (results?.length && !revivedFromHere) {
          groupedResults.push(...results.map(result => structuredClone(result)))
          repairedToolUseIds.push(block.id)
          continue
        }
        groupedResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: RECOVERY_TEXT,
          is_error: true,
        })
        if (revivedFromHere) synthesizedOrphanToolUseIds.push(block.id)
        else synthesizedToolUseIds.push(block.id)
      }
    }
    if (groupedResults.length > 0 && lastTool) {
      const existingCanonical = messages.find(candidate =>
        isPureToolResult(candidate)
        && candidate.parentUuid === lastTool.uuid
        && stable(toolResults(candidate)) === stable(groupedResults))
      if (existingCanonical) {
        output.push(clone(existingCanonical))
        originalResultUuids.delete(existingCanonical.uuid)
        continue
      }
      const result = recoveryRecord(lastTool, groupedResults[0].tool_use_id, output.length)
      result.parentUuid = lastTool.uuid
      result.type = 'user'
      result.message = { role: 'user', content: groupedResults }
      output.push(result)
      for (const originalResult of originalResultRecords) {
        if (toolResults(originalResult).some(block => groupedResults.some(resultBlock => resultBlock.tool_use_id === block.tool_use_id))) {
          const index = output.findIndex(candidate => candidate.uuid === originalResult.uuid)
          if (index >= 0) output.splice(index, 1)
          originalResultUuids.add(originalResult.uuid)
        }
      }
    }
  }

  const canonical: TranscriptMessage[] = []
  for (const message of output) {
    const isResultRecord = toolResults(message).length > 0
    if (!isResultRecord) {
      canonical.push(message)
      continue
    }
    const existingIndex = canonical.findIndex(candidate => toolResults(candidate).length > 0)
    if (existingIndex >= 0) canonical.splice(existingIndex, 1)
    canonical.push(message)
  }
  const retained = new Set(canonical.map(message => message.uuid))
  const droppedMessageUuids = messages
    .filter(message => !retained.has(message.uuid) && !resultUuids.has(message.uuid) && message.type !== 'tool_use')
    .map(message => message.uuid)

  if (!validProtocol(canonical)) {
    return {
      messages: original,
      report: { repaired: false, repairedToolUseIds: [], synthesizedToolUseIds: [], synthesizedOrphanToolUseIds: [], droppedMessageUuids: [] },
    }
  }

  const repaired = stable(original) !== stable(canonical)
  return {
    messages: repaired ? canonical : original,
    report: {
      repaired,
      repairedToolUseIds: repaired ? repairedToolUseIds : [],
      synthesizedToolUseIds: repaired ? synthesizedToolUseIds : [],
      synthesizedOrphanToolUseIds: repaired ? synthesizedOrphanToolUseIds : [],
      droppedMessageUuids: repaired ? droppedMessageUuids : [],
    },
  }
}

/**
 * 在 `TranscriptStore` 文件锁内运行 `repairTranscriptToolPairs`。
 * 仅当修复器报告发生变更时 (`report.repaired === true`) 才把修复后的
 * messages 写回磁盘；幂等调用因为没有变更，不会触发落盘，
 * 也不刷新 `meta.updatedAt`。该入口是 transcript 修复命令对外的唯一
 * 持久化路径，queryLoop 不直接调用此函数（见 Task 3）。
 */
export async function repairAndPersistTranscript(
  store: TranscriptStore,
  sessionId: string,
): Promise<TranscriptRepairResult> {
  return store.mutateMessages(sessionId, messages => {
    const result = repairTranscriptToolPairs(messages)
    return {
      messages: result.messages,
      changed: result.report.repaired,
      value: result,
    }
  })
}
