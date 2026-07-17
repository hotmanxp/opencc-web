import { describe, expect, test } from 'vitest'
import { splitMarkdownOnIncomplete } from './splitMarkdown.js'

describe('splitMarkdownOnIncomplete', () => {
  test('空字符串返回空 complete 与 tail', () => {
    expect(splitMarkdownOnIncomplete('')).toEqual({ complete: '', tail: '' })
  })

  test('无 \n\n 的单段全部归 tail', () => {
    expect(splitMarkdownOnIncomplete('Hello **bold')).toEqual({
      complete: '',
      tail: 'Hello **bold',
    })
  })

  test('以 \n\n 结尾时 complete 含 \n\n, tail 为空', () => {
    expect(splitMarkdownOnIncomplete('Hello\n\n')).toEqual({
      complete: 'Hello\n\n',
      tail: '',
    })
  })

  test('多段, 最后段未结束', () => {
    expect(splitMarkdownOnIncomplete('A\n\nB ')).toEqual({
      complete: 'A\n\n',
      tail: 'B ',
    })
  })

  test('完整闭合围栏 (无语言)', () => {
    expect(splitMarkdownOnIncomplete('```\nx\n```')).toEqual({
      complete: '```\nx\n```',
      tail: '',
    })
  })

  test('完整闭合围栏 (带语言)', () => {
    expect(splitMarkdownOnIncomplete('```python\nx\n```')).toEqual({
      complete: '```python\nx\n```',
      tail: '',
    })
  })

  test('未闭合围栏: complete 为空, tail 含围栏', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n')).toEqual({
      complete: '',
      tail: '```py\nx\n',
    })
  })

  test('已闭合围栏 + 后续未完 prose', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n```\nMore')).toEqual({
      complete: '```py\nx\n```\n',
      tail: 'More',
    })
  })

  test('4 个反引号围栏', () => {
    expect(splitMarkdownOnIncomplete('````md\n````')).toEqual({
      complete: '````md\n````',
      tail: '',
    })
  })

  test('围栏内含 \n\n 不应误判为段落结束', () => {
    expect(splitMarkdownOnIncomplete('```py\na\n\nb\n```')).toEqual({
      complete: '```py\na\n\nb\n```',
      tail: '',
    })
  })

  test('已闭合围栏 + 段落分隔 + 后续 prose', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n```\nMore\n\nYet more')).toEqual({
      complete: '```py\nx\n```\nMore\n\n',
      tail: 'Yet more',
    })
  })

  test('已闭合围栏 + 后续多行 prose', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n```\nMore\nstill more')).toEqual({
      complete: '```py\nx\n```\n',
      tail: 'More\nstill more',
    })
  })

  test('关闭围栏带尾随空格', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n``` \nMore')).toEqual({
      complete: '```py\nx\n``` \n',
      tail: 'More',
    })
  })
})
