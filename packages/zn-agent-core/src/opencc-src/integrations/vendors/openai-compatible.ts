import { defineVendor } from '../define.js'

// Generic "openai-compatible" vendor slot. Used by services that speak the
// OpenAI chat-completions protocol but are NOT api.openai.com (e.g. wizard-ai,
// Gitlawb Opengateway, DashScope, etc.). Specific first-party OpenAI requests
// continue to go through the `openai` vendor.
export default defineVendor({
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  classification: 'openai-compatible',
  defaultBaseUrl: '',
  defaultModel: '',
  setup: {
    requiresAuth: false,
    authMode: 'none',
  },
  transportConfig: {
    kind: 'openai-compatible',
  },
  usage: { supported: false },
})
