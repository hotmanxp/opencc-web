import { describe, expect, it } from 'bun:test'
import { analyzeScript } from './staticAnalyzer.js'

describe('analyzeScript', () => {
  it('returns empty phases for empty source', () => {
    const r = analyzeScript('')
    expect(r.phases).toEqual([])
    expect(r.estimatedAgents).toBe(0)
  })

  it('detects a sequential agent() call', () => {
    const r = analyzeScript(`
async function userScript(args) {
  const r = await agent("first", { label: "a" });
  return r.report;
}
`)
    expect(r.phases).toHaveLength(1)
    expect(r.phases[0]).toMatchObject({ kind: 'sequential', agents: [{ prompt: 'first' }] })
    expect(r.estimatedAgents).toBe(1)
  })

  it('detects a parallel([...]) of agent() calls', () => {
    const r = analyzeScript(`
async function userScript() {
  const results = await parallel([
    () => agent("p1"),
    () => agent("p2"),
    () => agent("p3"),
  ]);
}
`)
    expect(r.phases).toHaveLength(1)
    expect(r.phases[0]).toMatchObject({ kind: 'parallel', annotation: '×3' })
    expect(r.phases[0]?.agents).toHaveLength(3)
    expect(r.estimatedAgents).toBe(9)
  })

  it('detects a for-loop with agent() inside', () => {
    const r = analyzeScript(`
async function userScript() {
  for (let i = 0; i < angles.length; i++) {
    await agent(angles[i], { label: angles[i] });
  }
}
`)
    expect(r.phases).toHaveLength(1)
    expect(r.phases[0]?.kind).toBe('loop')
    expect(r.phases[0]?.annotation).toMatch(/i < angles\.length/)
    expect(r.phases[0]?.agents).toHaveLength(1)
  })

  it('detects multiple sequential agent() calls', () => {
    const r = analyzeScript(`
async function userScript() {
  await agent("first");
  await agent("second");
  await agent("third");
}
`)
    expect(r.phases).toHaveLength(3)
    expect(r.phases.every(p => p.kind === 'sequential')).toBe(true)
    expect(r.estimatedAgents).toBe(3)
  })

  it('detects hasReturn when script contains "return "', () => {
    const r = analyzeScript(`async function userScript() { return "done"; }`)
    expect(r.hasReturn).toBe(true)
  })

  it('handles nested agent calls inside async function', () => {
    const r = analyzeScript(`
async function userScript() {
  await parallel([
    () => agent("a"),
    () => parallel([
      () => agent("b"),
      () => agent("c"),
    ]),
  ]);
}
`)
    expect(r.phases).toHaveLength(1)
    expect(r.phases[0]?.kind).toBe('parallel')
    expect(r.phases[0]?.agents).toHaveLength(2)
  })

  it('truncates prompts longer than 60 chars', () => {
    const longPrompt = 'x'.repeat(80)
    const r = analyzeScript(`await agent("${longPrompt}")`)
    expect(r.phases[0]?.agents[0]?.prompt.length).toBeLessThanOrEqual(60)
  })

  it('deduplicates identical prompts', () => {
    const r = analyzeScript(`
await agent("same");
await agent("same");
await agent("same");
`)
    expect(r.phases).toHaveLength(1)
    expect(r.phases[0]?.agents).toHaveLength(1)
  })
})