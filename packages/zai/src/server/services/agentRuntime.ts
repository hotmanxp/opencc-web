import { homedir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import { DefaultAgentRuntime, resolveDataDir, TranscriptStore } from '@zn-ai/zai-agent-core'
import { createAnthropicModelCaller } from './modelCaller.js'
import { AskRegistry } from './askRegistry.js'

let runtime: DefaultAgentRuntime | null = null
let currentSessionId: string | null = null
let transcriptStore: TranscriptStore | null = null
const askRegistry = new AskRegistry()

export function getAskRegistry(): AskRegistry {
  return askRegistry
}

// 默认走 ~/.agents/skills (与 Nova CLI / OpenCode / OpenCC 共享, 见根 AGENTS.md).
// 没这个默认 SkillTool 永远不会注册, 用户得自己写代码喂 skillsDirs, 违反 "out of the box".
// ZAI_SKILLS_DIRS='' → 显式禁用; 不设 → 用默认; 设值 → 用 env (path.delimiter 分割).
const AGENTS_SKILLS_DIR = join(homedir(), '.agents', 'skills')
function resolveSkillsDirs(): string[] {
  const env = process.env.ZAI_SKILLS_DIRS
  if (env === undefined) return [AGENTS_SKILLS_DIR]
  if (env === '') return []
  return env.split(path.delimiter).filter(Boolean)
}

export function initAgentRuntime(): void {
  if (runtime) return
  const { resolved: dataDir } = resolveDataDir()
  transcriptStore = new TranscriptStore(dataDir)
  runtime = new DefaultAgentRuntime({
    dataDir,
    modelCaller: createAnthropicModelCaller(),
    defaultModel:
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    askRegistry,
    skillsDirs: resolveSkillsDirs(),
  })
}

export async function getOrCreateAgentSession(): Promise<string | null> {
  return null
}

export function setCurrentSessionId(id: string): void {
  currentSessionId = id
}

export function getCurrentSessionId(): string | null {
  return currentSessionId
}

export function getRuntime(): DefaultAgentRuntime {
  if (!runtime) throw new Error('Agent runtime not initialized')
  return runtime
}

export function getTranscriptStore(): TranscriptStore {
  if (!transcriptStore) throw new Error('Transcript store not initialized')
  return transcriptStore
}

export async function abortAgentSession(reason?: string): Promise<void> {
  askRegistry.abortAll(reason ?? 'session_aborted')
  if (currentSessionId) {
    await getRuntime().abort(currentSessionId, reason)
  }
}
