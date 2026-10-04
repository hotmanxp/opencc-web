import React from 'react'
import { getAPIProvider } from '../utils/model/providers.js'

type Props = {
  onDone: () => void
}

function getProviderLabel(): string {
  const provider = getAPIProvider()
  switch (provider) {
    // @ts-expect-error provider type mismatch
    case 'bedrock':
      return 'AWS Bedrock'
    // @ts-expect-error provider type mismatch
    case 'vertex':
      return 'Google Vertex'
    // @ts-expect-error provider type mismatch
    case 'foundry':
      return 'Azure Foundry'
    case 'openai':
      return 'OpenAI-compatible API'
    case 'gemini':
      return 'Gemini API'
    default:
      return 'API'
  }
}

export function CostThresholdDialog({ onDone }: Props): React.ReactNode | null {
  return null;
}
