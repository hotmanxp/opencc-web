import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'openplatform',
  label: 'Open Platform (开放平台)',
  canonicalVendorId: 'anthropic',
  defaultCapabilities: {
    supportsVision: true,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: true,
  },
  modelIds: [
    'openplatform-minimax-m3',
    'openplatform-minimax-m2.7-highspeed',
    'openplatform-minimax-m2.7',
    'openplatform-qwen3.6-plus',
    'openplatform-qwen3.7-plus',
    'openplatform-qwen3.7-max',
    'openplatform-glm-5.1',
    'openplatform-glm-5.2',
    'openplatform-glm-5',
    'openplatform-deepseek-v4-flash',
    'openplatform-deepseek-v4-pro',
  ],
})
