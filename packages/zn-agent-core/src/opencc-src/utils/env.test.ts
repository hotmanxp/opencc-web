// @ts-nocheck
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL,
  USER_TYPE: process.env.USER_TYPE,
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'opencc-env-test-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  delete process.env.USER_TYPE
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (originalEnv.OPENCC_CONFIG_DIR === undefined) {
    delete process.env.OPENCC_CONFIG_DIR
  } else {
    process.env.OPENCC_CONFIG_DIR = originalEnv.OPENCC_CONFIG_DIR
  }
  if (originalEnv.CLAUDE_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalEnv.CLAUDE_CONFIG_DIR
  }
  if (originalEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalEnv.CLAUDE_CODE_CUSTOM_OAUTH_URL
  }
  if (originalEnv.USER_TYPE === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalEnv.USER_TYPE
  }
})

async function importFreshEnvModule() {
  return import(`./env.js?ts=${Date.now()}-${Math.random()}`)
}

// getGlobalClaudeFile — three migration branches

test('getGlobalClaudeFile: new install returns .claude.json when neither file exists', async () => {
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, '.claude.json'))
})

test('getGlobalClaudeFile: existing user keeps .claude.json when only legacy file exists', async () => {
  writeFileSync(join(tempDir, '.claude.json'), '{}')
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, '.claude.json'))
})

test('getGlobalClaudeFile: migrated user uses .claude.json when both files exist', async () => {
  writeFileSync(join(tempDir, '.claude.json'), '{}')
  writeFileSync(join(tempDir, '.claude.json'), '{}')
  const { getGlobalClaudeFile } = await importFreshEnvModule()
  expect(getGlobalClaudeFile()).toBe(join(tempDir, '.claude.json'))
})

test('getGlobalClaudeFile: OPENCC_CONFIG_DIR uses preferred config dir', async () => {
  const preferredDir = mkdtempSync(join(tmpdir(), 'opencc-preferred-env-test-'))
  try {
    process.env.OPENCC_CONFIG_DIR = preferredDir
    process.env.CLAUDE_CONFIG_DIR = tempDir

    const { getGlobalClaudeFile } = await importFreshEnvModule()

    expect(getGlobalClaudeFile()).toBe(join(preferredDir, '.claude.json'))
  } finally {
    rmSync(preferredDir, { recursive: true, force: true })
  }
})

test('getGlobalClaudeFile: OPENCC_CONFIG_DIR wins over CLAUDE_CONFIG_DIR', async () => {
  const preferredDir = mkdtempSync(join(tmpdir(), 'opencc-preferred-env-test-'))
  const legacyDir = mkdtempSync(join(tmpdir(), 'opencc-legacy-env-test-'))
  try {
    process.env.OPENCC_CONFIG_DIR = preferredDir
    process.env.CLAUDE_CONFIG_DIR = legacyDir

    const { getGlobalClaudeFile } = await importFreshEnvModule()

    expect(getGlobalClaudeFile()).toBe(join(preferredDir, '.claude.json'))
  } finally {
    rmSync(preferredDir, { recursive: true, force: true })
    rmSync(legacyDir, { recursive: true, force: true })
  }
})
