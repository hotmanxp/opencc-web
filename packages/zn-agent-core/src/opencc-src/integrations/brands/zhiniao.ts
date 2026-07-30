import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'zhiniao',
  label: 'ZhiNiao',
  canonicalVendorId: 'openai-compatible',
  defaultCapabilities: {
    supportsVision: true,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: [
    'zhiniao-minimax-m2.7-highspeed',
    'zhiniao-minimax-m2.7',
    'zhiniao-qwen3.6-plus',
    'zhiniao-glm-5.1',
  ],
})
