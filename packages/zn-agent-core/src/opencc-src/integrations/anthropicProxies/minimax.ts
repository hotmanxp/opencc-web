import { defineAnthropicProxy } from '../define.js'

// Anthropic-SDK proxy variant of the MiniMax route.
// Activated when the user sets ANTHROPIC_BASE_URL to api.minimaxi.com/anthropic
// (e.g. `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_MODEL=MiniMax-M3`).
// The OpenAI-compatible route id `minimax` (vendors/minimax.ts) is for users who
// prefer the OpenAI shim; this descriptor is for users who stay on the Anthropic
// SDK but route through the MiniMax proxy. Same model catalog.
export default defineAnthropicProxy({
  id: 'minimax-anthropic',
  label: 'MiniMax (Anthropic proxy)',
  classification: 'anthropic-proxy',
  defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
  defaultModel: 'MiniMax-M3',
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  },
  envVarConfig: {
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    modelEnvVar: 'ANTHROPIC_MODEL',
  },
  capabilities: {
    supportsVision: true,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  transportConfig: {
    kind: 'anthropic-proxy',
  },
  // Mirror the minimax vendor catalog so getContextWindowForModel can resolve
  // MiniMax-M3 to its 1M/512K descriptor through resolveModelRuntimeLimits.
  catalog: {
    source: 'static',
    models: [
      { id: 'minimax-m2', apiName: 'MiniMax-M2', label: 'MiniMax M2', modelDescriptorId: 'minimax-m2' },
      { id: 'minimax-m2.1', apiName: 'MiniMax-M2.1', label: 'MiniMax M2.1', modelDescriptorId: 'minimax-m2.1' },
      { id: 'minimax-m2.1-highspeed', apiName: 'MiniMax-M2.1-highspeed', label: 'MiniMax M2.1 Highspeed', modelDescriptorId: 'minimax-m2.1-highspeed' },
      { id: 'minimax-m2.5', apiName: 'MiniMax-M2.5', label: 'MiniMax M2.5', modelDescriptorId: 'minimax-m2.5' },
      { id: 'minimax-m2.5-highspeed', apiName: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed', modelDescriptorId: 'minimax-m2.5-highspeed' },
      { id: 'minimax-m2.7', apiName: 'MiniMax-M2.7', label: 'MiniMax M2.7', modelDescriptorId: 'minimax-m2.7' },
      { id: 'minimax-m2.7-highspeed', apiName: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', modelDescriptorId: 'minimax-m2.7-highspeed' },
      { id: 'minimax-m3', apiName: 'MiniMax-M3', label: 'MiniMax M3', modelDescriptorId: 'minimax-m3' },
      { id: 'minimax-text-01', apiName: 'MiniMax-Text-01', label: 'MiniMax Text 01', modelDescriptorId: 'minimax-text-01' },
      { id: 'minimax-text-01-preview', apiName: 'MiniMax-Text-01-Preview', label: 'MiniMax Text 01 Preview', modelDescriptorId: 'minimax-text-01-preview' },
      { id: 'minimax-vision-01', apiName: 'MiniMax-Vision-01', label: 'MiniMax Vision 01', modelDescriptorId: 'minimax-vision-01' },
      { id: 'minimax-vision-01-fast', apiName: 'MiniMax-Vision-01-Fast', label: 'MiniMax Vision 01 Fast', modelDescriptorId: 'minimax-vision-01-fast' },
    ],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchBaseUrlHosts: ['api.minimaxi.com'],
    },
    credentialEnvVars: ['ANTHROPIC_AUTH_TOKEN', 'MINIMAX_API_KEY', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'MiniMax Anthropic-proxy auth is required. Set ANTHROPIC_AUTH_TOKEN, MINIMAX_API_KEY, or OPENAI_API_KEY.',
  },
  usage: { supported: true },
})
