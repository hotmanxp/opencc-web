import { describe, expect, it } from 'bun:test'
import {
  formatCoAuthorTrailer,
  parseCoAuthor,
  stripMatchingQuotes,
  USAGE,
} from './commit-message.js'

describe('commit-message command helpers', () => {
  it('parses quoted co-author names with a plain email', () => {
    expect(parseCoAuthor('"GPT 5.5" noreply@opencc.dev')).toEqual({
      name: 'GPT 5.5',
      email: 'noreply@opencc.dev',
    })
  })

  it('parses co-author trailers with angle-bracket emails', () => {
    expect(parseCoAuthor('OpenCC (gpt-5.5) <noreply@opencc.dev>')).toEqual(
      {
        name: 'OpenCC (gpt-5.5)',
        email: 'noreply@opencc.dev',
      },
    )
  })

  it('rejects co-author trailers with empty sanitized names', () => {
    expect(parseCoAuthor('"  " noreply@opencc.dev')).toBeNull()
    expect(parseCoAuthor('"  " <noreply@opencc.dev>')).toBeNull()
  })

  it('strips one pair of matching quotes from custom attribution text', () => {
    expect(stripMatchingQuotes('"Generated with OpenCC"')).toBe(
      'Generated with OpenCC',
    )
    expect(stripMatchingQuotes("'Generated with OpenCC'")).toBe(
      'Generated with OpenCC',
    )
    expect(stripMatchingQuotes('"Generated with OpenCC')).toBe(
      '"Generated with OpenCC',
    )
  })

  it('formats a sanitized co-author trailer', () => {
    expect(
      formatCoAuthorTrailer('OpenCC <gpt>\n', '<noreply@opencc.dev>'),
    ).toBe('Co-Authored-By: OpenCC gpt <noreply@opencc.dev>')
  })

  it('makes set scope explicit with example text', () => {
    expect(USAGE).toContain(
      'Controls only the attribution text appended after /commit messages.',
    )
    expect(USAGE).toContain(
      '/commit-message set "Generated with OpenCC using GPT-5.5"',
    )
    expect(USAGE).not.toContain('/commit-message set-attribution')
  })
})
