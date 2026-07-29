// src/tools/WorkflowTool/parseMetaFromScript.test.ts
import { describe, expect, it } from 'bun:test'
import { parseMetaFromScript } from './parseMetaFromScript.ts'

describe('parseMetaFromScript', () => {
 it('parses a valid export const meta = {...} as first statement', () => {
 const source = `
export const meta = { name: 'echo', description: 'Echoes args' }
async function userScript(args) { return args }
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(true)
 if (r.ok) {
 expect(r.value.meta).toEqual({ name: 'echo', description: 'Echoes args', phases: undefined })
 expect(r.value.scriptBody).toMatch(/async function userScript/)
 }
 })

 it('parses meta with phases array', () => {
 const source = `
export const meta = {
 name: 'foo',
 description: 'desc',
 phases: [
 { title: 'A', detail: 'first' },
 { title: 'B', detail: 'second', model: 'claude-sonnet-4-6' },
 ],
}
async function userScript() { return '' }
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(true)
 if (r.ok) {
 expect(r.value.meta.phases).toHaveLength(2)
 expect(r.value.meta.phases?.[0]).toEqual({ title: 'A', detail: 'first', model: undefined })
 expect(r.value.meta.phases?.[1]?.model).toBe('claude-sonnet-4-6')
 }
 })

 it('returns error when export const meta is missing', () => {
 const r = parseMetaFromScript('async function userScript() {}')
 expect(r.ok).toBe(false)
 if (!r.ok) {
 expect(r.error).toMatch(/FIRST statement/)
 }
 })

 it('returns error when no export const meta is found at all', () => {
 const r = parseMetaFromScript(`
const x =1
async function userScript() {}
`)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/FIRST statement/)
 })

 it('rejects TS type annotations on meta', () => {
 const source = `
export const meta: { name: string } = { name: 'x', description: 'x' }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) {
 expect(r.error).toMatch(/plain JavaScript|TS|type annotation/i)
 }
 })

 it('rejects computed property keys in meta', () => {
 const source = `
const k = 'name'
export const meta = { [k]: 'x', description: 'x' }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/computed/)
 })

 it('rejects spread in meta object', () => {
 const source = `
const base = { description: 'x' }
export const meta = { name: 'x', ...base }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/spread/)
 })

 it('rejects template literal with interpolation in meta', () => {
 const source = `
const n = 'x'
export const meta = { name: \`\${n}\`, description: 'x' }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/template interpolation|non-literal/)
 })

 it('rejects __proto__/constructor/prototype keys in meta', () => {
 const source = `
export const meta = { name: 'x', description: 'x', __proto__: { polluted: true } }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/reserved key|__proto__/)
 })

 it('rejects non-string name/description', () => {
 const source = `
export const meta = { name:42, description: 'x' }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/name must be a non-empty string/)
 })

 it('rejects empty name', () => {
 const source = `
export const meta = { name: '', description: 'x' }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(false)
 if (!r.ok) expect(r.error).toMatch(/name must be a non-empty string/)
 })

 it('extracts script body after meta declaration', () => {
 const source = `
export const meta = { name: 'x', description: 'y' }
// some comment
async function userScript(args) {
 return args
}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(true)
 if (r.ok) {
 expect(r.value.scriptBody).not.toMatch(/export const meta/)
 expect(r.value.scriptBody).toMatch(/async function userScript/)
 }
 })

 it('trims leading whitespace/newlines from script body', () => {
 const source = `export const meta = { name: 'x', description: 'y' }


async function userScript() {}`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(true)
 if (r.ok) {
 expect(r.value.scriptBody).toMatch(/^async function userScript/)
 }
 })

 it('handles negative number in meta (UnaryExpression)', () => {
 const source = `
export const meta = { name: 'x', description: 'y', maxRetries: -1 }
async function userScript() {}
`
 const r = parseMetaFromScript(source)
 expect(r.ok).toBe(true)
 if (r.ok) {
 expect((r.value.meta as unknown as { maxRetries: number }).maxRetries).toBe(-1)
 }
 })
})
