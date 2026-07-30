/**
 * OpenCC startup screen — filled-block text logo with sunset gradient.
 * Called once at CLI startup before the Ink UI renders.
 */

import { isLocalProviderUrl } from '../services/api/providerConfig.js'
import { stringWidth } from '../ink/stringWidth.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`

const ACCENT: RGB = [240, 148, 100]
const BORDER: RGB = [100, 80, 65]

function isLocalMode(): boolean {
  const useOpenAI = process.env.CLAUDE_CODE_USE_OPENAI === '1' || process.env.CLAUDE_CODE_USE_OPENAI === 'true'

  if (!useOpenAI) {
    return false
  }

  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  return isLocalProviderUrl(baseUrl)
}

// Strip ANSI escape codes to get visible string length
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

function boxRow(content: string, width: number): string {
  const rawLen = visibleLen(content)
  const pad = Math.max(0, width - 5 - rawLen)
  return `${rgb(...BORDER)}\u2502${RESET}  ${content}${' '.repeat(pad)} ${rgb(...BORDER)}\u2502${RESET}`
}

export function printStartupScreen(): void {
  // Skip in non-interactive / CI / print mode
  if (process.env.CI || !process.stdout.isTTY) return

  const isLocal = isLocalMode()
  const out: string[] = []

  out.push('')

  const sC: RGB = isLocal ? [130, 175, 130] : ACCENT
  const sL = isLocal ? 'local' : 'cloud'
  const versionStr = `opencc v${MACRO.DISPLAY_VERSION ?? MACRO.VERSION}`

  const dot = `${rgb(...sC)}\u25cf${RESET}`
  const mode = ` ${rgb(180, 180, 180)}${sL}${RESET}`
  const ready = `${rgb(100, 200, 100)}\u25cf Ready${RESET}`
  const version = `${rgb(255, 255, 255)}\u25cf ${versionStr}${RESET}`
  const help = `type ${rgb(...ACCENT)}/help${RESET}`

  const sRow = `${dot}${mode}  \u00b7  ${ready}  \u00b7  ${version}  \u00b7  ${help}`
  const sLen = visibleLen(sRow)

  const W = Math.max(62, sLen + 5)

  // Status line
  out.push(`${rgb(...BORDER)}\u2554${'\u2550'.repeat(W - 2)}\u2557${RESET}`)
  out.push(boxRow(sRow, W))
  out.push(`${rgb(...BORDER)}\u255a${'\u2550'.repeat(W - 2)}\u255d${RESET}`)

  process.stdout.write(out.join('\n') + '\n')
}

// Provider name detection based on baseUrl patterns and model names
function detectProviderFromUrl(baseUrl: string | undefined, model: string | undefined): { name: string; model?: string } {
  if (!baseUrl) {
    return detectProviderFromModel(model)
  }

  const url = baseUrl.toLowerCase()

  // OpenRouter
  if (url.includes('openrouter.ai')) {
    return { name: 'OpenRouter', model }
  }

  // Together AI
  if (url.includes('together.ai')) {
    return { name: 'Together AI', model }
  }

  // Groq
  if (url.includes('groq')) {
    return { name: 'Groq', model }
  }

  // Azure OpenAI
  if (url.includes('azure')) {
    return { name: 'Azure OpenAI', model }
  }

  // DeepSeek
  if (url.includes('deepseek.com')) {
    return { name: 'DeepSeek', model }
  }

  // Moonshot AI - Kimi Code (api.kimi.com)
  if (url.includes('api.kimi.com')) {
    return { name: 'Moonshot AI - Kimi Code', model }
  }

  // Moonshot AI - API (api.moonshot.cn)
  if (url.includes('moonshot.cn')) {
    return { name: 'Moonshot AI - API', model }
  }

  // Mistral
  if (url.includes('mistral.ai')) {
    return { name: 'Mistral', model }
  }

  // Z.AI GLM - only for api.z.ai, not generic URLs with glm model names
  if (url.includes('api.z.ai')) {
    return { name: 'Z.AI GLM', model }
  }

  // DashScope - treat as generic OpenAI (not Z.AI)
  if (url.includes('dashscope')) {
    return { name: 'OpenAI', model }
  }

  // Default: use model-based detection for generic proxy URLs
  return detectProviderFromModel(model)
}

// Detect provider from model name only (for generic URLs)
function detectProviderFromModel(model: string | undefined): { name: string; model?: string } {
  if (!model) {
    return { name: 'OpenAI' }
  }

  const modelLower = model.toLowerCase()

  // GLM detection: uppercase GLM-* is Z.AI, lowercase glm-* is generic
  // Note: Only uppercase GLM-* from api.z.ai is Z.AI, DashScope glm-* is generic
  if (model.startsWith('GLM-')) {
    return { name: 'Z.AI - GLM', model }
  }

  // Llama detection
  if (modelLower.includes('llama')) {
    return { name: 'Meta Llama', model }
  }

  // Mistral detection
  if (modelLower.includes('mistral')) {
    return { name: 'Mistral', model }
  }

  // DeepSeek detection
  if (modelLower.includes('deepseek')) {
    return { name: 'DeepSeek', model }
  }

  // Kimi detection
  if (modelLower.includes('kimi')) {
    return { name: 'Moonshot AI - Kimi Code', model }
  }

  // GLM lowercase is generic
  if (modelLower.startsWith('glm-')) {
    return { name: 'OpenAI', model }
  }

  return { name: 'OpenAI', model }
}

// detectProvider stub - delegates to providerAutoDetect logic for actual implementation
export function detectProvider(modelOverride?: string): { name: string; model?: string } {
  // Check for Anthropic API key first
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: 'Anthropic', model: modelOverride }
  }

  // Check for dedicated provider env flags (these override aggregator URLs)
  if (process.env.NVIDIA_NIM === '1') {
    return { name: 'NVIDIA NIM', model: modelOverride }
  }

  if (process.env.MINIMAX_API_KEY) {
    return { name: 'MiniMax', model: modelOverride }
  }

  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return { name: 'Gemini', model: modelOverride }
  }

  if (process.env.MISTRAL_API_KEY) {
    return { name: 'Mistral', model: modelOverride }
  }

  // Check for OpenAI-compatible mode
  if (process.env.CLAUDE_CODE_USE_OPENAI === '1' || process.env.CLAUDE_CODE_USE_OPENAI === 'true') {
    const baseUrl = process.env.OPENAI_BASE_URL
    const model = modelOverride ?? process.env.OPENAI_MODEL
    return detectProviderFromUrl(baseUrl, model)
  }

  // Check for other provider API keys
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEYS) {
    const baseUrl = process.env.OPENAI_BASE_URL
    const model = modelOverride ?? process.env.OPENAI_MODEL
    return detectProviderFromUrl(baseUrl, model)
  }

  // Default fallback
  return { name: 'Anthropic', model: modelOverride ?? 'sonnet' }
}
