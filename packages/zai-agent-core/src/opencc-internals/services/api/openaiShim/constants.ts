// @ts-nocheck
import { isEnvTruthy } from '../../../utils/envUtils.js'

const GEMINI_API_HOST = 'generativelanguage.googleapis.com'
const MOONSHOT_API_HOSTS = new Set([
  'api.moonshot.ai',
  'api.moonshot.cn',
])

const SENSITIVE_URL_QUERY_PARAM_NAMES = [
  'api_key',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'signature',
  'sig',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'authorization',
]

function isMistralMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)
}

function isGithubModelsMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
}

export {
  GEMINI_API_HOST,
  MOONSHOT_API_HOSTS,
  SENSITIVE_URL_QUERY_PARAM_NAMES,
  isMistralMode,
  isGithubModelsMode,
}
