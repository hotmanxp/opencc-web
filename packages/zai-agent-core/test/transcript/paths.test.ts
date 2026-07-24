import { describe, expect, it } from 'vitest'
import {
  generateTranscriptId,
  parseTranscriptId,
  projectDir,
  sanitizePath,
  transcriptDir,
  transcriptPath,
  transcriptsRoot,
  __resetProjectDirCacheForTest,
} from '../../src/transcript/paths.js'

describe('sanitizePath', () => {
  it('maps non-alphanumeric to dash', () => {
    expect(sanitizePath('/Users/ethan/code/opencc')).toBe('-Users-ethan-code-opencc')
  })

  it('keeps dots as dashes (matches opencc portable behavior)', () => {
    expect(sanitizePath('my.project')).toBe('my-project')
  })

  it('truncates + appends hash for long paths', () => {
    const long = '/' + 'x'.repeat(200)
    const out = sanitizePath(long)
    expect(out.length).toBeLessThanOrEqual(80 + 1 + 8) // 80 chars + '-' + short hash
    expect(out).toMatch(/-[a-z0-9]+$/)
  })

  it('is stable for same input', () => {
    const cwd = '/Users/ethan/code/opencc-web'
    expect(sanitizePath(cwd)).toBe(sanitizePath(cwd))
  })

  it('is memoized across calls (same cwd → same projectDir)', () => {
    __resetProjectDirCacheForTest()
    const a = projectDir('/data', '/Users/ethan/code/foo')
    const b = projectDir('/data', '/Users/ethan/code/foo')
    expect(a).toBe(b)
  })
})

describe('transcriptsRoot / projectDir', () => {
  it('transcriptsRoot is <dataDir>/transcripts', () => {
    expect(transcriptsRoot('/data')).toBe('/data/transcripts')
  })

  it('projectDir is <dataDir>/transcripts/projects/<sanitized cwd>', () => {
    expect(projectDir('/data', '/Users/ethan/code/opencc')).toBe(
      '/data/transcripts/projects/-Users-ethan-code-opencc',
    )
  })

  it('transcriptDir (legacy flat) still points to <dataDir>/transcripts for back-compat callers', () => {
    expect(transcriptDir('/data')).toBe('/data/transcripts')
  })
})

describe('transcriptPath', () => {
  it('main session lives at projectDir/<id>.json', () => {
    expect(
      transcriptPath('/data', 'sess-abc', { cwd: '/Users/ethan/code/opencc' }),
    ).toBe('/data/transcripts/projects/-Users-ethan-code-opencc/sess-abc.json')
  })

  it('subagent session lives at projectDir/subagents/<id>.json', () => {
    expect(
      transcriptPath('/data', 'sess-abc', {
        cwd: '/Users/ethan/code/opencc',
        subagent: true,
      }),
    ).toBe(
      '/data/transcripts/projects/-Users-ethan-code-opencc/subagents/sess-abc.json',
    )
  })
})

describe('generateTranscriptId / parseTranscriptId', () => {
  it('round-trips', () => {
    const id = generateTranscriptId()
    expect(id).toMatch(/^sess-[0-9a-f-]{36}$/i)
    expect(parseTranscriptId(id)).toBe(id)
  })

  it('rejects malformed ids', () => {
    expect(parseTranscriptId('not-a-sess')).toBeNull()
    expect(parseTranscriptId('sess-123')).toBeNull()
  })
})