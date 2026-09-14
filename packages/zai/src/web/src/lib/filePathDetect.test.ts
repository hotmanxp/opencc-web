import { describe, expect, it } from 'vitest'
import { isFilePath, splitFilePaths, toAbsolutePath } from './filePathDetect.js'

describe('isFilePath', () => {
  it('接受常见源码 / 配置 / 文档路径', () => {
    for (const p of [
      'src/index.ts',
      'packages/zai/src/web/src/lib/filePathDetect.ts',
      './src/a.tsx',
      '../shared/fs.ts',
      '/Users/ethan/code/opencc-web/package.json',
      'README.md',
      'docs/superpowers/specs/2026-08-26-zai-desktop-office-design.md',
      'src/.env',
      'Dockerfile',
      'packages/zai/tsconfig.json',
      '@zn-ai/zai/package.json',
    ]) {
      expect(isFilePath(p), p).toBe(true)
    }
  })

  it('拒绝版本号 / 域名 / 包名等非路径 token', () => {
    for (const p of [
      '1.5',
      'v1.2.3',
      'a.b.com',
      'example.com',
      'react-dom',
      'foo',
      '.env',
      'src/',
      'src/foo',
      'https://example.com/a.md',
      '//x.com/a.md',
      '--flag.ts',
      'has space/in it.ts',
      'a.tsx?query',
      'a.ts*',
    ]) {
      expect(isFilePath(p), p).toBe(false)
    }
  })
})

describe('splitFilePaths', () => {
  it('无命中时返回单个 text 片段', () => {
    expect(splitFilePaths('就是一句普通的话')).toEqual([
      { kind: 'text', value: '就是一句普通的话' },
    ])
  })

  it('圈出正文里的裸路径,保留前后文本', () => {
    expect(splitFilePaths('修好了 src/a.ts 里的问题')).toEqual([
      { kind: 'text', value: '修好了 ' },
      { kind: 'path', value: 'src/a.ts' },
      { kind: 'text', value: ' 里的问题' },
    ])
  })

  it('行号留在正文里,不并进路径', () => {
    expect(splitFilePaths('见 src/a.ts:42')).toEqual([
      { kind: 'text', value: '见 ' },
      { kind: 'path', value: 'src/a.ts' },
      { kind: 'text', value: ':42' },
    ])
  })

  it('跳过被拒绝的候选,不吞掉中间文本', () => {
    expect(splitFilePaths('版本 1.5 见 src/a.ts')).toEqual([
      { kind: 'text', value: '版本 1.5 见 ' },
      { kind: 'path', value: 'src/a.ts' },
    ])
  })

  it('URL 尾段不会被当成路径', () => {
    expect(splitFilePaths('详见 https://example.com/guide.md')).toEqual([
      { kind: 'text', value: '详见 https://example.com/guide.md' },
    ])
  })

  it('多个路径全部圈出', () => {
    expect(splitFilePaths('a/x.ts 和 b/y.md')).toEqual([
      { kind: 'path', value: 'a/x.ts' },
      { kind: 'text', value: ' 和 ' },
      { kind: 'path', value: 'b/y.md' },
    ])
  })

  it('括号 / 句号紧邻路径时不并入', () => {
    expect(splitFilePaths('(见 src/a.ts).')).toEqual([
      { kind: 'text', value: '(见 ' },
      { kind: 'path', value: 'src/a.ts' },
      { kind: 'text', value: ').' },
    ])
  })
})

describe('toAbsolutePath', () => {
  it('相对路径按 cwd 补全', () => {
    expect(toAbsolutePath('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(toAbsolutePath('./src/a.ts', '/repo')).toBe('/repo/src/a.ts')
  })

  it('去掉 cwd 尾随斜杠,避免双斜杠', () => {
    expect(toAbsolutePath('src/a.ts', '/repo/')).toBe('/repo/src/a.ts')
  })

  it('绝对路径 / ~ 路径原样返回', () => {
    expect(toAbsolutePath('/abs/a.ts', '/repo')).toBe('/abs/a.ts')
    expect(toAbsolutePath('~/a.ts', '/repo')).toBe('~/a.ts')
  })

  it('没有 cwd 时原样返回', () => {
    expect(toAbsolutePath('src/a.ts', null)).toBe('src/a.ts')
    expect(toAbsolutePath('src/a.ts', undefined)).toBe('src/a.ts')
  })
})
