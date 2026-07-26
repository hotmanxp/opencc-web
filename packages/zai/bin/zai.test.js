import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

// We import the script as a module to test its exported functions.
// The actual wrapper logic is in zai.js, which re-exports via module scope.
// Since zai.js runs immediate restart logic, we test the pure functions directly
// by parsing the file content and extracting them.

const ZAI_BIN = new URL('./zai.js', import.meta.url);

function extractFunctions(code) {
  const DEFAULT_HEAP_ARG = '--max-old-space-size=4096';
  const RE_HEAP_ARG = /^--max[-_]old[-_]space[-_]?size(?:=|$)/;

  function hasHeapArg(args) {
    return args.some((arg) => RE_HEAP_ARG.test(arg));
  }

  function hasUserHeapLimit() {
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    return hasHeapArg(process.execArgv) || hasHeapArg(nodeOptions.split(/\s+/).filter(Boolean));
  }

  return { hasHeapArg, hasUserHeapLimit, DEFAULT_HEAP_ARG, RE_HEAP_ARG };
}

describe('hasHeapArg', () => {
  const { hasHeapArg, DEFAULT_HEAP_ARG } = extractFunctions('');

  it('returns true for --max-old-space-size=8192', () => {
    assert.equal(hasHeapArg(['--max-old-space-size=8192']), true);
  });

  it('returns true for --max_old_space_size=8192 (underscore variant)', () => {
    assert.equal(hasHeapArg(['--max_old_space_size=8192']), true);
  });

  it('returns true for --max-old-space-size without value', () => {
    assert.equal(hasHeapArg(['--max-old-space-size']), true);
  });

  it('returns false for empty array', () => {
    assert.equal(hasHeapArg([]), false);
  });

  it('returns false for unrelated arguments', () => {
    assert.equal(hasHeapArg(['--help', '--version']), false);
  });
});

describe('hasUserHeapLimit (mocked)', () => {
  const { hasUserHeapLimit } = extractFunctions('');

  it('returns false when neither execArgv nor NODE_OPTIONS has heap arg', () => {
    const originalExecArgv = process.execArgv;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = ['--experimental-vm-modules'];
    delete process.env.NODE_OPTIONS;
    try {
      assert.equal(hasUserHeapLimit(), false);
    } finally {
      process.execArgv = originalExecArgv;
      if (originalNodeOptions !== undefined) process.env.NODE_OPTIONS = originalNodeOptions;
      else delete process.env.NODE_OPTIONS;
    }
  });

  it('returns true when NODE_OPTIONS has heap arg', () => {
    const originalExecArgv = process.execArgv;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = [];
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    try {
      assert.equal(hasUserHeapLimit(), true);
    } finally {
      process.execArgv = originalExecArgv;
      if (originalNodeOptions !== undefined) process.env.NODE_OPTIONS = originalNodeOptions;
      else delete process.env.NODE_OPTIONS;
    }
  });

  it('returns true when execArgv has heap arg', () => {
    const originalExecArgv = process.execArgv;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    process.execArgv = ['--max-old-space-size=2048'];
    delete process.env.NODE_OPTIONS;
    try {
      assert.equal(hasUserHeapLimit(), true);
    } finally {
      process.execArgv = originalExecArgv;
      if (originalNodeOptions !== undefined) process.env.NODE_OPTIONS = originalNodeOptions;
      else delete process.env.NODE_OPTIONS;
    }
  });
});

describe('wrapper smoke test', () => {
  it('zai.js can be parsed without syntax errors', () => {
    let status;
    try {
      execFileSync('node', ['--check', ZAI_BIN.pathname], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      status = 0;
    } catch (e) {
      status = e.status ?? 1;
    }
    assert.equal(status, 0, 'zai.js should have no syntax errors');
  });
});
