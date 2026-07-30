// Stub for attributionTrailer - not used in open build since COMMIT_ATTRIBUTION is false
import type { AttributionData } from './commitAttribution.js'
import type { AttributionTexts } from './attribution.js'

export function buildPRTrailers(
  _attributionData: AttributionData,
  _attribution: AttributionTexts,
): string[] {
  return []
}
