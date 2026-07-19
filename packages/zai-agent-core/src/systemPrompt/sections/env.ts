/**
 * Environment section for the system prompt.
 *
 * Mirrors opencc's `computeSimpleEnvInfo` (prompts.ts:673-732), trimmed
 * to what zai needs:
 *
 *   - cwd (resolved via CwdStore per-session)
 *   - git repo flag (lightweight `existsSync('.git')` check)
 *   - platform + os release
 *   - shell (zsh / bash / unknown)
 *   - model marketing name (driven by the model's canonical id)
 *   - knowledge cutoff (per-model hardcoded table)
 *
 * What we dropped vs opencc:
 *   - "additional working directories" — zai-agent-core doesn't have
 *     a multi-dir permission mode yet
 *   - "this is a git worktree" line — sub-agent cwd isolation is
 *     tracked separately via CwdStore (runtime/cwdStore.ts)
 *   - the ant-only "fast mode" line — no FastMode toggle in zai
 *
 * The section is cached per `(model, cwd-key)` so flipping model
 * triggers a recompute but the same model across turns reuses the
 * string. Cwd-key is the resolved cwd from `getCwd()` at compute
 * time, since per-session cwd is mutable (LLM-self-cwd-switch).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type as osType, release as osRelease } from 'node:os'
import { getCwd } from '../../opencc-internals/utils/cwd.js'
import { systemPromptSection } from '../section.js'
import type { SectionComputeContext } from './context.js'

type EnvInfo = {
  cwd: string
  isGit: boolean
  platform: NodeJS.Platform
  shell: string
  modelId: string
  modelDescription: string
  knowledgeCutoff: string | null
  unameSR: string
}

function detectShell(): string {
  const shell = process.env.SHELL ?? ''
  if (shell.includes('zsh')) return 'zsh'
  if (shell.includes('bash')) return 'bash'
  return shell || 'unknown'
}

function detectGit(cwd: string): boolean {
  try {
    return existsSync(join(cwd, '.git'))
  } catch {
    return false
  }
}

function unameSR(): string {
  return process.platform === 'win32'
    ? `${osRelease()}`
    : `${osType()} ${osRelease()}`
}

const MODEL_MARKETING_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'OpenCC Opus 4.6',
  'claude-sonnet-4-6': 'OpenCC Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'OpenCC Haiku 4.5',
}

const MODEL_KNOWLEDGE_CUTOFFS: Record<string, string> = {
  'claude-sonnet-4-6': 'August 2025',
  'claude-opus-4-6': 'May 2025',
  'claude-opus-4-5': 'May 2025',
  'claude-haiku-4': 'February 2025',
  'claude-opus-4': 'January 2025',
  'claude-sonnet-4': 'January 2025',
}

function canonicalId(modelId: string): string {
  for (const key of Object.keys(MODEL_KNOWLEDGE_CUTOFFS)) {
    if (modelId.includes(key)) return key
  }
  return modelId
}

function collectEnv(modelId: string): EnvInfo {
  const cwd = getCwd()
  const canon = canonicalId(modelId)
  const marketing = MODEL_MARKETING_NAMES[canon]
  return {
    cwd,
    isGit: detectGit(cwd),
    platform: process.platform,
    shell: detectShell(),
    modelId,
    modelDescription: marketing
      ? `You are powered by the model named ${marketing}. The exact model ID is ${modelId}.`
      : `You are powered by the model ${modelId}.`,
    knowledgeCutoff: MODEL_KNOWLEDGE_CUTOFFS[canon] ?? null,
    unameSR: unameSR(),
  }
}

function formatEnv(info: EnvInfo): string {
  const items = [
    `Primary working directory: ${info.cwd}`,
    `Is a git repository: ${info.isGit}`,
    `Platform: ${info.platform}`,
    `Shell: ${info.shell} ${info.platform === 'win32' ? '(use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)' : ''}`.trim(),
    `OS Version: ${info.unameSR}`,
    info.modelDescription,
    info.knowledgeCutoff
      ? `Assistant knowledge cutoff is ${info.knowledgeCutoff}.`
      : null,
  ].filter((s): s is string => s !== null)

  return [
    `# Environment`,
    `You have been invoked in the following environment:`,
    ...items.map(s => ` - ${s}`),
  ].join('\n')
}

export function getEnvInfoSection(ctx: SectionComputeContext) {
  return systemPromptSection(`env_info:${ctx.model}`, () => {
    const info = collectEnv(ctx.model)
    return formatEnv(info)
  })
}