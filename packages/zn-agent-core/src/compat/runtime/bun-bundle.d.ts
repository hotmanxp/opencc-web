declare module 'bun:bundle' {
  export function feature<T>(flag: string, defaultValue?: T): T | boolean
  export function require(id: string): never
}
