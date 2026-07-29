/**
 * Minimal stub for the `env-paths` npm package. opencc vendor uses
 * it to find XDG cache/data/config/log paths; for zai we don't have
 * it installed but the calls happen early (cachePaths.ts). We return
 * a single tmpdir-based path so subsequent fs ops have somewhere to
 * write if they actually try.
 */

export default function envPaths(name: string, options?: { suffix?: string }): {
  cache: string
  config: string
  data: string
  log: string
  temp: string
} {
  const suffix = options?.suffix ?? ''
  return {
    cache: `/tmp/${name}${suffix}`,
    config: `/tmp/${name}${suffix}`,
    data: `/tmp/${name}${suffix}`,
    log: `/tmp/${name}${suffix}`,
    temp: `/tmp/${name}${suffix}`,
  }
}
