/**
 * Default no-op implementations for opencc Tool interface methods.
 *
 * opencc's Tool interface in `opencc-src/Tool.ts` requires ~30 methods.
 * zai-side tools only implement a subset (call, inputSchema, name, description).
 * This file provides shared default impls for the rest so wrappers don't
 * repeat boilerplate.
 */

export function noopReactNode(): null {
  return null
}

export function falseFn(): false {
  return false
}

export function trueFn(): true {
  return true
}

export async function defaultDescription(
  _input: unknown,
  _options: unknown,
): Promise<string> {
  return '(no description)'
}

export function defaultUserFacingName(input: { name: string }): string {
  return input.name
}
