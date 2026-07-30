import { defineGateway } from '../define.js'

// 平安内部开放平台 (Anthropic-MIX preset) — OpenAI-compatible aggregator
// hosted at zn-nova.paic.com.cn/novai. No API key required (internal network,
// already-activated endpoint). All model names are bare (no zhiniao- prefix
// — that prefix only applies to wizard-ai.paic.com.cn).
export default defineGateway({
  id: 'zn-nova',
  label: 'Anthropic-MIX (平安 novai)',
  category: 'aggregating',
  defaultBaseUrl: 'https://zn-nova.paic.com.cn/novai',
  defaultModel: 'MiniMax-M3',
  supportsModelRouting: true,
  vendorId: 'anthropic',
  setup: {
    requiresAuth: false,
    authMode: 'none',
  },
  validation: {
    kind: 'credential-env',
    // Empty credentialEnvVars + requiresAuth: false = no key needed.
    // OPENAI_API_KEY is auto-added by getRouteCredentialEnvVars for
    // openai-compatible routes; if unset the request still goes through.
    credentialEnvVars: [],
    missingCredentialMessage:
      'zn-nova gateway is pre-activated on the internal 平安 network and does not require an API key.',
    routing: {
      matchBaseUrlHosts: ['zn-nova.paic.com.cn'],
    },
  },
  transportConfig: {
    kind: 'anthropic-proxy',
  },
  preset: {
    id: 'zn-nova',
    description:
      'Ping An internal 开放平台 (Anthropic-MIX) — OpenAI-compatible aggregator hosting MiniMax / Qwen / GLM / DeepSeek models at zn-nova.paic.com.cn/novai (no API key required)',
    label: 'Anthropic-MIX',
    name: 'Anthropic-MIX',
    vendorId: 'anthropic',
    baseUrlEnvVars: ['ZN_NOVA_BASE_URL', 'OPENAI_BASE_URL'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  catalog: {
    source: 'static',
    models: [
      {
        id: 'zn-nova-minimax-m3',
        apiName: 'MiniMax-M3',
        label: 'MiniMax M3 (via 平安 novai)',
        modelDescriptorId: 'openplatform-minimax-m3',
      },
      {
        id: 'zn-nova-minimax-m2.7-highspeed',
        apiName: 'MiniMax-M2.7-highspeed',
        label: 'MiniMax M2.7 Highspeed (via 平安 novai)',
        modelDescriptorId: 'openplatform-minimax-m2.7-highspeed',
      },
      {
        id: 'zn-nova-minimax-m2.7',
        apiName: 'MiniMax-M2.7',
        label: 'MiniMax M2.7 (via 平安 novai)',
        modelDescriptorId: 'openplatform-minimax-m2.7',
      },
      {
        id: 'zn-nova-qwen3.6-plus',
        apiName: 'qwen3.6-plus',
        label: 'Qwen 3.6 Plus (via 平安 novai)',
        modelDescriptorId: 'openplatform-qwen3.6-plus',
      },
      {
        id: 'zn-nova-qwen3.7-plus',
        apiName: 'qwen3.7-plus',
        label: 'Qwen 3.7 Plus (via 平安 novai)',
        modelDescriptorId: 'openplatform-qwen3.7-plus',
      },
      {
        id: 'zn-nova-qwen3.7-max',
        apiName: 'qwen3.7-max',
        label: 'Qwen 3.7 Max (via 平安 novai)',
        modelDescriptorId: 'openplatform-qwen3.7-max',
      },
      {
        id: 'zn-nova-glm-5',
        apiName: 'glm-5',
        label: 'GLM 5 (via 平安 novai)',
        modelDescriptorId: 'openplatform-glm-5',
      },
      {
        id: 'zn-nova-glm-5.1',
        apiName: 'glm-5.1',
        label: 'GLM 5.1 (via 平安 novai)',
        modelDescriptorId: 'openplatform-glm-5.1',
      },
      {
        id: 'zn-nova-glm-5.2',
        apiName: 'glm-5.2',
        label: 'GLM 5.2 (via 平安 novai)',
        modelDescriptorId: 'openplatform-glm-5.2',
      },
      {
        id: 'zn-nova-deepseek-v4-flash',
        apiName: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash (via 平安 novai)',
        modelDescriptorId: 'openplatform-deepseek-v4-flash',
      },
      {
        id: 'zn-nova-deepseek-v4-pro',
        apiName: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro (via 平安 novai)',
        modelDescriptorId: 'openplatform-deepseek-v4-pro',
      },
    ],
  },
  usage: { supported: false },
})
