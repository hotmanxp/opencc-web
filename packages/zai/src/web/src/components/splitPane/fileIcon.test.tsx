// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { classifyFile, FileIcon, DirIcon } from './fileIcon.js';

describe('classifyFile', () => {
  it('maps common code extensions to their kinds', () => {
    expect(classifyFile('index.ts')).toBe('ts');
    expect(classifyFile('App.tsx')).toBe('tsx');
    expect(classifyFile('main.mts')).toBe('ts');
    expect(classifyFile('main.cts')).toBe('ts');
    expect(classifyFile('foo.d.ts')).toBe('ts');
    expect(classifyFile('foo.test.ts')).toBe('ts');
    expect(classifyFile('foo.spec.ts')).toBe('ts');
    expect(classifyFile('foo.test.tsx')).toBe('tsx');
    expect(classifyFile('foo.spec.tsx')).toBe('tsx');
    expect(classifyFile('vite.config.ts')).toBe('ts');
    expect(classifyFile('vite.config.js')).toBe('js');
    expect(classifyFile('vite.config.cjs')).toBe('js');
    expect(classifyFile('vite.config.mjs')).toBe('js');

    expect(classifyFile('app.js')).toBe('js');
    expect(classifyFile('app.jsx')).toBe('jsx');
    expect(classifyFile('app.mjs')).toBe('js');
    expect(classifyFile('app.cjs')).toBe('js');

    expect(classifyFile('main.py')).toBe('py');
    expect(classifyFile('main.pyi')).toBe('py');
    expect(classifyFile('main.go')).toBe('go');
    expect(classifyFile('main.rs')).toBe('rs');
    expect(classifyFile('Foo.java')).toBe('java');
    expect(classifyFile('Foo.kt')).toBe('kt');
    expect(classifyFile('Foo.kts')).toBe('kt');
    expect(classifyFile('main.c')).toBe('c');
    expect(classifyFile('main.h')).toBe('c');
    expect(classifyFile('main.cpp')).toBe('cpp');
    expect(classifyFile('main.cc')).toBe('cpp');
    expect(classifyFile('main.cxx')).toBe('cpp');
    expect(classifyFile('main.hpp')).toBe('cpp');
  });

  it('maps web / config / data extensions', () => {
    expect(classifyFile('index.html')).toBe('html');
    expect(classifyFile('page.htm')).toBe('html');
    expect(classifyFile('styles.css')).toBe('css');
    expect(classifyFile('app.scss')).toBe('scss');
    expect(classifyFile('app.sass')).toBe('scss');
    expect(classifyFile('app.less')).toBe('scss');

    expect(classifyFile('package.json')).toBe('json');
    expect(classifyFile('tsconfig.json')).toBe('json');
    expect(classifyFile('tsconfig.base.json')).toBe('json');
    expect(classifyFile('events.jsonl')).toBe('jsonl');
    expect(classifyFile('events.ndjson')).toBe('jsonl');

    expect(classifyFile('README.md')).toBe('md');
    expect(classifyFile('readme.md')).toBe('md');
    expect(classifyFile('readme')).toBe('md');
    expect(classifyFile('NOTES.markdown')).toBe('md');

    expect(classifyFile('vite.config.yaml')).toBe('yaml');
    expect(classifyFile('vite.config.yml')).toBe('yaml');
    expect(classifyFile('cargo.toml')).toBe('toml');
    expect(classifyFile('paper.tex')).toBe('tex');
    expect(classifyFile('refs.bib')).toBe('tex');
  });

  it('maps special filenames by whole name (not extension)', () => {
    // 这些走全名判定,扩展名兜底是 other / text,但应该优先命中专用 kind
    expect(classifyFile('.gitignore')).toBe('git');
    expect(classifyFile('.gitattributes')).toBe('git');
    expect(classifyFile('.gitmodules')).toBe('git');
    expect(classifyFile('.dockerignore')).toBe('git');

    expect(classifyFile('.npmrc')).toBe('npmrc');
    expect(classifyFile('.yarnrc')).toBe('npmrc');
    expect(classifyFile('.pnpmrc')).toBe('npmrc');
    expect(classifyFile('.yarnrc.yml')).toBe('npmrc');

    expect(classifyFile('.env')).toBe('env');
    expect(classifyFile('.env.local')).toBe('env');
    expect(classifyFile('.env.production')).toBe('env');

    expect(classifyFile('Dockerfile')).toBe('docker');
    expect(classifyFile('Dockerfile.dev')).toBe('docker');
    expect(classifyFile('Containerfile')).toBe('docker');

    expect(classifyFile('Makefile')).toBe('makefile');
    expect(classifyFile('GNUmakefile')).toBe('makefile');
    expect(classifyFile('Rakefile')).toBe('makefile');

    expect(classifyFile('LICENSE')).toBe('license');
    expect(classifyFile('LICENSE.md')).toBe('license');
    expect(classifyFile('LICENSE.txt')).toBe('license');
  });

  it('maps shell / lock / media / office / archive extensions', () => {
    expect(classifyFile('run.sh')).toBe('sh');
    expect(classifyFile('run.bash')).toBe('sh');
    expect(classifyFile('run.zsh')).toBe('sh');
    expect(classifyFile('run.fish')).toBe('sh');
    // pnpm-lock.yaml 是带 lock 后缀的 yaml, 整体还是 yaml; 单独的 .lock 才是 lock
    expect(classifyFile('pnpm-lock.yaml')).toBe('yaml');
    expect(classifyFile('yarn.lock')).toBe('lock');
    expect(classifyFile('foo.LOCK')).toBe('lock');

    expect(classifyFile('photo.png')).toBe('image');
    expect(classifyFile('photo.JPG')).toBe('image');
    expect(classifyFile('icon.svg')).toBe('image');
    expect(classifyFile('logo.webp')).toBe('image');

    expect(classifyFile('cv.pdf')).toBe('pdf');
    expect(classifyFile('report.doc')).toBe('doc');
    expect(classifyFile('report.docx')).toBe('doc');
    expect(classifyFile('report.rtf')).toBe('doc');
    expect(classifyFile('sheet.xls')).toBe('xls');
    expect(classifyFile('sheet.xlsx')).toBe('xls');
    expect(classifyFile('sheet.csv')).toBe('xls');
    expect(classifyFile('deck.ppt')).toBe('ppt');
    expect(classifyFile('deck.pptx')).toBe('ppt');

    expect(classifyFile('data.zip')).toBe('archive');
    expect(classifyFile('data.tar.gz')).toBe('archive'); // last ext wins
    expect(classifyFile('mirror.tgz')).toBe('archive');
    expect(classifyFile('app.jar')).toBe('archive');
    expect(classifyFile('app.war')).toBe('archive');
  });

  it('falls back to other / text / log for unknown / prose', () => {
    expect(classifyFile('random.xyz')).toBe('other');
    expect(classifyFile('notes.txt')).toBe('text');
    expect(classifyFile('app.log')).toBe('log');
  });

  it('returns other for files with no extension (except known names)', () => {
    expect(classifyFile('')).toBe('other');
    expect(classifyFile('no-extension-file')).toBe('other');
    // 这些"无扩展但常见"的名字走全名分支
    expect(classifyFile('Dockerfile')).toBe('docker');
    expect(classifyFile('Makefile')).toBe('makefile');
  });

  it('is case insensitive on the extension', () => {
    expect(classifyFile('README.MD')).toBe('md');
    expect(classifyFile('foo.TS')).toBe('ts');
    expect(classifyFile('foo.TSX')).toBe('tsx');
    expect(classifyFile('foo.JSON')).toBe('json');
    expect(classifyFile('FOO.PDF')).toBe('pdf');
  });
});

describe('FileIcon / DirIcon', () => {
  it('FileIcon tags kind + renders an svg shape per category', () => {
    // 形状区分是 FsTab 的核心价值,我们断言:
    //   1. [data-file-ext] 正确挂上(供 CSS 着色)
    //   2. 实际 svg 元素存在(确认 antd 给我们回了 icon,不是裸 span)
    // 具体的 svg path / icon id 由 antd 保证,这里不重复 antd 的契约.
    const { container: md } = render(<FileIcon name="README.md" />);
    expect(md.querySelector('[data-file-ext="md"]')).toBeTruthy();
    expect(md.querySelector('svg')).toBeTruthy();

    const { container: pdf } = render(<FileIcon name="cv.pdf" />);
    expect(pdf.querySelector('[data-file-ext="pdf"]')).toBeTruthy();
    expect(pdf.querySelector('svg')).toBeTruthy();

    const { container: img } = render(<FileIcon name="logo.svg" />);
    expect(img.querySelector('[data-file-ext="image"]')).toBeTruthy();
    expect(img.querySelector('svg')).toBeTruthy();

    const { container: zip } = render(<FileIcon name="data.zip" />);
    expect(zip.querySelector('[data-file-ext="archive"]')).toBeTruthy();
    expect(zip.querySelector('svg')).toBeTruthy();

    const { container: tsx } = render(<FileIcon name="App.tsx" />);
    expect(tsx.querySelector('[data-file-ext="tsx"]')).toBeTruthy();
    expect(tsx.querySelector('svg')).toBeTruthy();

    const { container: ts } = render(<FileIcon name="index.ts" />);
    expect(ts.querySelector('[data-file-ext="ts"]')).toBeTruthy();
    expect(ts.querySelector('svg')).toBeTruthy();
  });

  it('DirIcon always exposes data-dir="true" and switches Folder variants by open prop', () => {
    // FolderOutlined 和 FolderOpenOutlined 对应不同的 svg 路径,我们不直接比 svg,
    // 但要保证两个分支都正确进入(open=true 和 open=false 都不挂错属性).
    const { container: closed } = render(<DirIcon name="src" open={false} />);
    expect(closed.querySelector('[data-dir="true"]')).toBeTruthy();
    expect(closed.querySelector('svg')).toBeTruthy();

    const { container: opened } = render(<DirIcon name="src" open={true} />);
    expect(opened.querySelector('[data-dir="true"]')).toBeTruthy();
    expect(opened.querySelector('svg')).toBeTruthy();
  });
});
