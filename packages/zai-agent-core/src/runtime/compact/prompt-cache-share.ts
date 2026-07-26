/**
 * Dual path 判断:Anthropic → prompt cache sharing,其他 → cold path。
 *
 * spec §4.4。
 */

export function isCompactionCacheSharingCompatible(providerKind: string | undefined | null): boolean {
  return providerKind === 'anthropic'
}