// Stub for attributionTrailer - not used in open build since COMMIT_ATTRIBUTION is false
import type { AttributionData } from './commitAttribution.ts'
import type { AttributionTexts } from './attribution.ts'

export function buildPRTrailers(
  _attributionData: AttributionData,
  _attribution: AttributionTexts,
): string[] {
  return []
}
