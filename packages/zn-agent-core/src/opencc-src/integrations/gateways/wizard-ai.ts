import { defineGateway } from '../define.js'

// Ping An Tech's Wizard AI gateway (wizard-ai.paic.com.cn) hosts every model
// under the `zhiniao-` prefix. The shim auto-prepends the prefix when the
// base URL hostname contains "wizard-ai" (see
// src/services/api/openaiShim/providerUtils.ts: applyZhiniaoModelPrefix), so
// users can pass bare model names. Catalog entries here use the explicit
// prefixed apiName, which makes the UI display unambiguous and lets the shim
// short-circuit with a no-op.
export default defineGateway({
  id: 'wizard-ai',
  label: 'Wizard AI (ZhiNiao)',
  category: 'aggregating',
  defaultBaseUrl: 'https://wizard-ai.paic.com.cn/code_pilot/api/v1',
  defaultModel: 'zhiniao-MiniMax-M2.7',
  supportsModelRouting: true,
  vendorId: 'openai-compatible',
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['WIZARD_AI_API_KEY', 'OPENAI_API_KEY'],
  },
  validation: {
    kind: 'credential-env',
    credentialEnvVars: ['WIZARD_AI_API_KEY', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'Wizard AI gateway requires an API key. ' +
      'Set WIZARD_AI_API_KEY (or OPENAI_API_KEY when OPENAI_BASE_URL points at wizard-ai).',
    routing: {
      matchBaseUrlHosts: ['wizard-ai.paic.com.cn'],
    },
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      // Standard Bearer auth — no custom header needed.
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
    },
  },
  preset: {
    id: 'wizard-ai',
    description:
      'Ping An Tech Wizard AI gateway (wizard-ai.paic.com.cn) — OpenAI-compatible aggregator that hosts zhiniao-prefixed model names',
    label: 'Wizard AI (ZhiNiao)',
    name: 'Wizard AI (ZhiNiao)',
    vendorId: 'openai-compatible',
    apiKeyEnvVars: ['WIZARD_AI_API_KEY', 'OPENAI_API_KEY'],
    baseUrlEnvVars: ['WIZARD_AI_BASE_URL', 'OPENAI_BASE_URL'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  catalog: {
    source: 'static',
    models: [
      {
        id: 'zhiniao-MiniMax-M2.7-highspeed',
        apiName: 'zhiniao-MiniMax-M2.7-highspeed',
        label: 'MiniMax M2.7 Highspeed (via Wizard AI)',
        modelDescriptorId: 'zhiniao-MiniMax-M2.7-highspeed',
      },
      {
        id: 'zhiniao-MiniMax-M2.7',
        apiName: 'zhiniao-MiniMax-M2.7',
        label: 'MiniMax M3 (via Wizard AI)',
        modelDescriptorId: 'zhiniao-MiniMax-M2.7',
      },
      {
        id: 'zhiniao-qwen3.6-plus',
        apiName: 'zhiniao-qwen3.6-plus',
        label: 'Qwen 3.6 Plus (via Wizard AI)',
        modelDescriptorId: 'zhiniao-qwen3.6-plus',
      },
      {
        id: 'zhiniao-glm-5.1',
        apiName: 'zhiniao-glm-5.1',
        label: 'GLM 5.1 (via Wizard AI)',
        modelDescriptorId: 'zhiniao-glm-5.1',
      },
    ],
  },
  usage: { supported: false },
})
