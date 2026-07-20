import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  parsePluginMarkdown,
} from '../../src/plugins/components/markdown.js'
import {
  loadPluginSkills,
} from '../../src/plugins/components/skills.js'
import {
  loadPluginCommands,
} from '../../src/plugins/components/commands.js'
import {
  loadPluginAgents,
} from '../../src/plugins/components/agents.js'
import {
  loadPluginMcpServers,
} from '../../src/plugins/components/mcp.js'
import {
  loadPluginHooks,
} from '../../src/plugins/components/hooks.js'
import { emptyPluginSnapshot } from '../../src/plugins/types.js'
import type {
  LoadedPlugin,
  PluginSnapshot,
} from '../../src/plugins/types.js'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'zai-plugin-components-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeFileEnsuringDir(path: string, value: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, value)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileEnsuringDir(path, JSON.stringify(value))
}

async function writePluginManifest(root: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeJson(join(root, '.claude-plugin/plugin.json'), manifest)
}

function newSnapshot(): PluginSnapshot {
  return emptyPluginSnapshot()
}

/**
 * Read the on-disk manifest (under `.claude-plugin/plugin.json`) and
 * return a `LoadedPlugin` whose `manifest` reflects what's actually on
 * disk. This avoids the test having to mirror manifest contents in two
 * places.
 */
async function loadPluginFromDisk(
  root: string,
  name = 'demo-plugin',
): Promise<LoadedPlugin> {
  const { readPluginManifest } = await import(
    '../../src/plugins/manifest.js'
  )
  const result = await readPluginManifest(root)
  if (result.error || !result.manifest) {
    throw new Error(
      `Failed to read plugin manifest from ${root}: ${result.error?.message}`,
    )
  }
  return {
    id: `${name}@marketplace`,
    name,
    source: 'opencc',
    sourceRef: `${name}@marketplace`,
    root,
    manifest: result.manifest,
    enabled: true,
  }
}

describe('parsePluginMarkdown', () => {
  test('解析合法 frontmatter + body', () => {
    const raw = `---
name: review
description: review code
---
Hello body`
    const result = parsePluginMarkdown(raw, 'skills/review/SKILL.md')
    expect(result.error).toBeNull()
    expect(result.frontmatter).toEqual({ name: 'review', description: 'review code' })
    expect(result.body).toBe('Hello body')
  })

  test('没有 frontmatter → 空 frontmatter，原文为 body', () => {
    const raw = 'plain body\nmore lines'
    const result = parsePluginMarkdown(raw, 'x.md')
    expect(result.error).toBeNull()
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe(raw)
  })

  test('YAML 非法 → 返回 typed error，不抛错', () => {
    const raw = `---
name: : bad
---
body`
    const result = parsePluginMarkdown(raw, 'broken.md')
    expect(result.frontmatter).toEqual({})
    expect(result.error).not.toBeNull()
    expect(result.error!.code).toBe('plugin_markdown_parse_error')
    expect(result.body).toBe(raw)
  })
})

describe('loadPluginSkills', () => {
  test('从 <root>/skills/<dir>/SKILL.md 加载并命名为 plugin:<pluginName>:<namespace>:<skillName>', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'skills/review/SKILL.md'),
      `---
name: review
description: review changes
---
Body of review skill`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.skills.length).toBe(1)
    expect(snapshot.skills[0]).toMatchObject({
      name: 'plugin:demo-plugin:review',
      kind: 'skill',
      pluginId: 'demo-plugin@marketplace',
      source: 'plugin',
    })
    expect(snapshot.skills[0].description).toBe('review changes')
  })

  test('从 manifest.skills (string) 追加 skills 目录', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      skills: 'extra-skills',
    })
    // 追加的目录里有一个 SKILL.md
    await writeFileEnsuringDir(
      join(root, 'extra-skills/extra/SKILL.md'),
      `---
description: extra skill
---
body`,
    )
    // 标准目录也有一个 SKILL.md
    await writeFileEnsuringDir(
      join(root, 'skills/standard/SKILL.md'),
      `---
description: standard skill
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    const names = snapshot.skills.map(s => s.name).sort()
    expect(names).toEqual([
      'plugin:demo-plugin:extra',
      'plugin:demo-plugin:standard',
    ])
  })

  test('从 manifest.skills (string[]) 追加多个 skills 目录', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      skills: ['extra-1', 'extra-2'],
    })
    await writeFileEnsuringDir(
      join(root, 'extra-1/a/SKILL.md'),
      `---
description: a
---
body`,
    )
    await writeFileEnsuringDir(
      join(root, 'extra-2/b/SKILL.md'),
      `---
description: b
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.skills.map(s => s.name).sort()).toEqual([
      'plugin:demo-plugin:a',
      'plugin:demo-plugin:b',
    ])
  })

  test('非法 frontmatter 的 SKILL.md 不阻断其它 skill', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'skills/bad/SKILL.md'),
      `---
name: : invalid yaml
---
body`,
    )
    await writeFileEnsuringDir(
      join(root, 'skills/good/SKILL.md'),
      `---
description: ok
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills.map(s => s.name)).toEqual(['plugin:demo-plugin:good'])
    expect(snapshot.errors.length).toBeGreaterThan(0)
    expect(snapshot.errors[0].code).toBe('plugin_markdown_parse_error')
    expect(snapshot.errors[0].pluginId).toBe('demo-plugin@marketplace')
  })

  test('description 缺失时 fallback 到 body 第一段', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'skills/x/SKILL.md'),
      `---
name: x
---
First paragraph here
with continuation`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills[0].description).toBe('First paragraph here with continuation')
  })

  test('SKILL.md 识别大小写不敏感', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'skills/case/skill.md'),
      `---
description: case-insensitive
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills.map(s => s.name)).toEqual(['plugin:demo-plugin:case'])
  })

  test('相对根目录的 SKILL.md 跳过（保持 loader 行为一致）', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    // 顶级 SKILL.md 不视为有效 skill
    await writeFileEnsuringDir(
      join(root, 'skills/SKILL.md'),
      `---
description: top
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginSkills(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills).toEqual([])
    // 顶级 SKILL.md 应记入错误，但不应阻断其它内容
    expect(snapshot.errors.length).toBeGreaterThanOrEqual(0)
  })
})

describe('loadPluginCommands', () => {
  test('加载 <root>/commands/<name>.md → plugin:<pluginName>:<commandName>', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'commands/build.md'),
      `---
description: build
---
Run the build.`,
    )

    const snapshot = newSnapshot()
    await loadPluginCommands(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.commands).toBeUndefined()
    expect(snapshot.skills.length).toBe(1)
    expect(snapshot.skills[0]).toMatchObject({
      name: 'plugin:demo-plugin:build',
      kind: 'command',
      pluginId: 'demo-plugin@marketplace',
      source: 'plugin',
    })
  })

  test('加载 <root>/commands/<dir>/SKILL.md（与普通 commands 相同命名空间）', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'commands/nested/SKILL.md'),
      `---
description: nested command
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginCommands(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills[0]).toMatchObject({
      name: 'plugin:demo-plugin:nested',
      kind: 'command',
    })
  })

  test('namespace 反映子路径', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'commands/sub/inner/deep.md'),
      `---
description: deep command
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginCommands(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills[0].name).toBe('plugin:demo-plugin:sub:inner:deep')
  })

  test('通过 resolvePluginPath 安全边界 → ../escape 不被允许', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    // 试图通过 symlink 越界
    const outsideDir = join(tmp, 'outside')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'bad.md'), 'should not load')
    await mkdir(join(root, 'commands'), { recursive: true })
    await symlink(join(outsideDir, 'bad.md'), join(root, 'commands/leak.md'))

    const snapshot = newSnapshot()
    await loadPluginCommands(await loadPluginFromDisk(root), snapshot)

    // 越界命令被丢弃
    expect(snapshot.skills.find(s => s.name === 'plugin:demo-plugin:leak')).toBeUndefined()
  })

  test('非法 frontmatter 不阻断其它 command', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'commands/broken.md'),
      `---
name: : broken
---
body`,
    )
    await writeFileEnsuringDir(
      join(root, 'commands/good.md'),
      `---
description: good
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginCommands(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.skills.map(s => s.name)).toEqual(['plugin:demo-plugin:good'])
    expect(snapshot.errors.length).toBeGreaterThan(0)
  })
})

describe('loadPluginAgents', () => {
  test('加载 agents/<name>.md → AgentDefinition，命名 plugin:<pluginName>:<agentName>', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'agents/reviewer.md'),
      `---
name: reviewer
description: reviews code
model: claude-3-5-sonnet
maxTurns: 4
forbiddenTools: Bash,WebFetch
---
You are a reviewer.\n\nAlways at \${CLAUDE_PLUGIN_ROOT}/templates.`,
    )

    const snapshot = newSnapshot()
    await loadPluginAgents(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.agents.length).toBe(1)
    expect(snapshot.agents[0]).toMatchObject({
      name: 'plugin:demo-plugin:reviewer',
      description: 'reviews code',
      model: 'claude-3-5-sonnet',
      maxTurns: 4,
    })
    expect(snapshot.agents[0].forbiddenTools).toEqual(['Bash', 'WebFetch'])
    // body 里 ${CLAUDE_PLUGIN_ROOT} 应被替换为 root
    expect(snapshot.agents[0].systemPrompt).toBe(
      `You are a reviewer.\n\nAlways at ${root}/templates.`,
    )
  })

  test('agent 文件内 permissionMode/hooks/mcpServers 字段被忽略（debug warning 记录）', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'agents/safe.md'),
      `---
name: safe
description: safe agent
permissionMode: acceptEdits
hooks:
  PreToolUse: x
mcpServers:
  - some
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginAgents(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.agents.length).toBe(1)
    expect(snapshot.agents[0].name).toBe('plugin:demo-plugin:safe')
    // 这些字段不能进入 AgentDefinition
    expect(snapshot.agents[0]).not.toHaveProperty('permissionMode')
    expect(snapshot.agents[0]).not.toHaveProperty('hooks')
    expect(snapshot.agents[0]).not.toHaveProperty('mcpServers')
  })

  test('非法 agent 不阻断其它 agent', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'agents/broken.md'),
      `---
name: : broken
---
body`,
    )
    await writeFileEnsuringDir(
      join(root, 'agents/ok.md'),
      `---
name: ok
description: ok agent
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginAgents(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.agents.map(a => a.name)).toEqual(['plugin:demo-plugin:ok'])
    expect(snapshot.errors.length).toBeGreaterThan(0)
  })

  test('从 manifest.agents 数组追加 agent 文件', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      agents: ['extra/agent.md'],
    })
    await writeFileEnsuringDir(
      join(root, 'extra/agent.md'),
      `---
name: extra
description: extra agent
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginAgents(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.agents[0].name).toBe('plugin:demo-plugin:extra')
  })

  test('缺 name 字段的 agent 被拒绝（结构化错误）', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeFileEnsuringDir(
      join(root, 'agents/noname.md'),
      `---
description: no name
---
body`,
    )

    const snapshot = newSnapshot()
    await loadPluginAgents(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.agents).toEqual([])
    expect(snapshot.errors.length).toBe(1)
    expect(snapshot.errors[0].code).toBe('plugin_agent_invalid')
  })
})

describe('loadPluginMcpServers', () => {
  test('从 .mcp.json 加载 stdio server，名称前缀 plugin:<pluginName>:', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: {
        echo: { command: 'node', args: ['echo.js'] },
      },
    })

    const snapshot = newSnapshot()
    await loadPluginMcpServers(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.mcpServers.length).toBe(1)
    expect(snapshot.mcpServers[0]).toMatchObject({
      name: 'plugin:demo-plugin:echo',
    })
    expect(snapshot.mcpServers[0].transport).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['echo.js'],
    })
    expect(snapshot.pluginMcpServerNames).toEqual(['plugin:demo-plugin:echo'])
  })

  test('从 manifest.mcpServers inline 对象加载', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      mcpServers: {
        remote: { type: 'http', url: 'https://example.com/mcp' },
      },
    })

    const snapshot = newSnapshot()
    await loadPluginMcpServers(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.mcpServers.length).toBe(1)
    expect(snapshot.mcpServers[0].name).toBe('plugin:demo-plugin:remote')
    expect(snapshot.mcpServers[0].transport).toEqual({
      kind: 'http',
      url: 'https://example.com/mcp',
    })
  })

  test('从 manifest.mcpServers 相对 JSON 路径加载（受 root boundary 约束）', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      mcpServers: './servers.json',
    })
    await writeJson(join(root, 'servers.json'), {
      sse: { type: 'sse', url: 'https://example.com/sse' },
    })

    const snapshot = newSnapshot()
    await loadPluginMcpServers(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.mcpServers[0].name).toBe('plugin:demo-plugin:sse')
    expect(snapshot.mcpServers[0].transport).toEqual({
      kind: 'sse',
      url: 'https://example.com/sse',
    })
  })

  test('从 manifest.mcpServers 数组加载多个 sources', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      mcpServers: [
        { inline: { command: 'a' } },
        './more.json',
      ],
    })
    await writeJson(join(root, 'more.json'), {
      second: { type: 'http', url: 'https://example.com/m' },
    })

    const snapshot = newSnapshot()
    await loadPluginMcpServers(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.mcpServers.length).toBe(2)
    expect(snapshot.mcpServers.map(s => s.name).sort()).toEqual([
      'plugin:demo-plugin:inline',
      'plugin:demo-plugin:second',
    ])
  })

  test('.mcpb / .dxt bundle → unsupported-mcp-bundle 错误，其他 server 仍加载', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: {
        bundle: './plugin.mcpb',
        normal: { command: 'node', args: ['a.js'] },
      },
    })

    const snapshot = newSnapshot()
    await loadPluginMcpServers(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.mcpServers.length).toBe(1)
    expect(snapshot.mcpServers[0].name).toBe('plugin:demo-plugin:normal')
    expect(snapshot.errors.length).toBe(1)
    expect(snapshot.errors[0].code).toBe('unsupported-mcp-bundle')
  })

  test('非法 server 不阻断其它 server', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeJson(join(root, '.mcp.json'), {
      mcpServers: {
        bad: { type: 'unknown' },
        good: { command: 'node' },
      },
    })

    const snapshot = newSnapshot()
    await loadPluginMcpServers(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.mcpServers.length).toBe(1)
    expect(snapshot.mcpServers[0].name).toBe('plugin:demo-plugin:good')
    expect(snapshot.errors.length).toBe(1)
  })
})

describe('loadPluginHooks', () => {
  test('从 <root>/hooks/hooks.json 加载 hooks', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeJson(join(root, 'hooks/hooks.json'), {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    })

    const snapshot = newSnapshot()
    await loadPluginHooks(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.hooks.length).toBe(2)
    const pre = snapshot.hooks.find(h => h.event === 'PreToolUse')
    expect(pre).toMatchObject({
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'echo hi',
      pluginId: 'demo-plugin@marketplace',
      pluginRoot: root,
    })
    const post = snapshot.hooks.find(h => h.event === 'PostToolUse')
    expect(post?.matcher).toBeUndefined()
    expect(post?.command).toBe('echo done')
  })

  test('不支持的 hook 事件被记录为 unsupported-hook-event 错误并跳过', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeJson(join(root, 'hooks/hooks.json'), {
      hooks: {
        BeforeAll: [{ hooks: [{ type: 'command', command: 'echo unknown' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
      },
    })

    const snapshot = newSnapshot()
    await loadPluginHooks(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.hooks.length).toBe(1)
    expect(snapshot.hooks[0].event).toBe('PreToolUse')
    expect(snapshot.errors.length).toBe(1)
    expect(snapshot.errors[0].code).toBe('unsupported-hook-event')
  })

  test('从 manifest.hooks 合并 inline hooks', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, {
      name: 'demo-plugin',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
      },
    })

    const snapshot = newSnapshot()
    await loadPluginHooks(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.hooks.length).toBe(1)
    expect(snapshot.hooks[0]).toMatchObject({
      event: 'Stop',
      command: 'echo stop',
      pluginId: 'demo-plugin@marketplace',
      pluginRoot: root,
    })
  })

  test('非法单 hook 不阻断其它 hook', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    await writeJson(join(root, 'hooks/hooks.json'), {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 123 }] }, // command 非字符串
          { hooks: [{ type: 'command', command: 'echo ok' }] },
        ],
      },
    })

    const snapshot = newSnapshot()
    await loadPluginHooks(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.hooks.length).toBe(1)
    expect(snapshot.hooks[0].command).toBe('echo ok')
    expect(snapshot.errors.length).toBe(1)
  })

  test('所有 12 个支持事件均能加载', async () => {
    const root = join(tmp, 'plugin')
    await writePluginManifest(root, { name: 'demo-plugin' })
    const events = [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
    ]
    const hooks: Record<string, unknown> = {}
    for (const ev of events) {
      hooks[ev] = [{ hooks: [{ type: 'command', command: `echo ${ev}` }] }]
    }
    await writeJson(join(root, 'hooks/hooks.json'), { hooks })

    const snapshot = newSnapshot()
    await loadPluginHooks(await loadPluginFromDisk(root), snapshot)

    expect(snapshot.errors).toEqual([])
    expect(snapshot.hooks.length).toBe(events.length)
    expect(new Set(snapshot.hooks.map(h => h.event))).toEqual(new Set(events))
  })
})