// src/tools/StructuredOutputTool/textJsonExtractor.test.ts
//
// Unit tests for findFirstBalancedJsonValue — the shared helper used by
// the WorkflowTool runtime's text-fallback path. Each test exercises one
// shape the helper is expected to handle; regression coverage lives in
// realSpawner.test.ts (integration with schema validation).

import { describe, expect, it } from 'bun:test'
import { findFirstBalancedJsonValue } from './textJsonExtractor.ts'

describe('findFirstBalancedJsonValue', () => {
  describe('object values', () => {
    it('extracts a bare JSON object', () => {
      expect(findFirstBalancedJsonValue('{"type":"node"}')).toBe(
        '{"type":"node"}',
      )
    })

    it('extracts JSON object with leading prose', () => {
      expect(
        findFirstBalancedJsonValue(
          'The answer is {"type":"node"} because I read package.json',
        ),
      ).toBe('{"type":"node"}')
    })

    it('extracts JSON object followed by trailing prose', () => {
      expect(
        findFirstBalancedJsonValue(
          '{"type":"node"} and some trailing notes',
        ),
      ).toBe('{"type":"node"}')
    })

    it('extracts nested JSON object', () => {
      expect(
        findFirstBalancedJsonValue(
          '{"data":{"type":"node","version":"0.18.0"}}',
        ),
      ).toBe('{"data":{"type":"node","version":"0.18.0"}}')
    })

    it('handles braces inside JSON string values without unbalancing', () => {
      expect(
        findFirstBalancedJsonValue('Here: {"key":"a {nested} brace"} ok'),
      ).toBe('{"key":"a {nested} brace"}')
    })

    it('handles escaped quotes inside JSON string values', () => {
      expect(
        findFirstBalancedJsonValue(
          'Result: {"key":"she said \\"hi\\""} done',
        ),
      ).toBe('{"key":"she said \\"hi\\""}')
    })

    it('extracts first of multiple JSON objects in prose', () => {
      // Common LLM pattern: emit answer, then restate in another form.
      // We take the FIRST balanced value — that's the actual answer.
      expect(
        findFirstBalancedJsonValue(
          'Answer: {"a":1} (also {"b":2} as alternative)',
        ),
      ).toBe('{"a":1}')
    })

    it('handles JSON wrapped in markdown code fence', () => {
      expect(
        findFirstBalancedJsonValue('```json\n{"type":"node"}\n```'),
      ).toBe('{"type":"node"}')
    })
  })

  describe('array values', () => {
    it('extracts a bare JSON array', () => {
      expect(findFirstBalancedJsonValue('[1,2,3]')).toBe('[1,2,3]')
    })

    it('extracts JSON array embedded in prose', () => {
      expect(
        findFirstBalancedJsonValue('Results: [1,2,3] end of message'),
      ).toBe('[1,2,3]')
    })

    it('handles nested arrays', () => {
      expect(findFirstBalancedJsonValue('[[1,2],[3,4]]')).toBe('[[1,2],[3,4]]')
    })
  })

  describe('string scalar values', () => {
    it('extracts a bare string scalar with quotes', () => {
      expect(findFirstBalancedJsonValue('"node"')).toBe('"node"')
    })

    it('extracts string scalar embedded in prose', () => {
      expect(findFirstBalancedJsonValue('The type is "node" by the way')).toBe(
        '"node"',
      )
    })

    it('handles escaped quotes inside string scalar', () => {
      expect(findFirstBalancedJsonValue('"she said \\"hi\\""')).toBe(
        '"she said \\"hi\\""',
      )
    })
  })

  describe('non-matches (returns undefined)', () => {
    it('plain prose with no JSON', () => {
      expect(
        findFirstBalancedJsonValue("I don't know what the answer is"),
      ).toBeUndefined()
    })

    it('empty string', () => {
      expect(findFirstBalancedJsonValue('')).toBeUndefined()
    })

    it('unbalanced JSON (missing closing brace)', () => {
      // The extractor can only return balanced substrings — half-open
      // JSON is treated as no match. Caller falls through to failure.
      expect(findFirstBalancedJsonValue('{"type":"node"')).toBeUndefined()
    })

    it('number scalar (no opening quote/brace)', () => {
      // Caller handles bare scalars via JSON.parse(trimmedText) — the
      // extractor doesn't need to.
      expect(findFirstBalancedJsonValue('42')).toBeUndefined()
    })

    it('boolean / null scalars (no opening quote/brace)', () => {
      expect(findFirstBalancedJsonValue('true')).toBeUndefined()
      expect(findFirstBalancedJsonValue('null')).toBeUndefined()
    })
  })
})
