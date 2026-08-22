/**
 * dsh-bridge MCP schema converter — 单元测试。
 *
 * Bug 背景：
 *   dsh-tools 的 `defineTool({ parameters })` 期望 parameters 是 flat
 *   property map (`Record<paramName, ValueSchemaSpec>`)，不是 JSON Schema。
 *   但 `mcpToolsToDshTools` 此前把 MCP 原始 inputSchema(含 type:'object'
 *   + properties + required[])原样传入,dsh-tools 的
 *   `parameterSchemaSpecToJsonSchema` 把它当作 property map 编译,
 *   遇到顶层 `type` key 时抛
 *   `parameters.type must be a value schema object` 并 abort createKernel。
 *
 * 修复:`mcpInputSchemaToParameterSpec` 把 MCP raw schema 转成 flat
 *       property map,每个 leaf 收敛为合规 ValueSchemaSpec。
 */

import { describe, it, expect } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  mcpInputSchemaToParameterSpec,
  convertMcpValueSchema,
} from '../../src/tools/mcpSchema.js'

describe('dsh-bridge mcpSchema converter', () => {
  it('converts basic MCP object schema to flat property map', () => {
    const input = {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'page URL' },
        timeout: { type: 'number' },
        verbose: { type: 'boolean' },
      },
      required: ['url'],
    }
    const out = mcpInputSchemaToParameterSpec(input)
    expect(out).toEqual({
      url: { type: 'string', description: 'page URL', required: true },
      timeout: { type: 'number' },
      verbose: { type: 'boolean' },
    })
  })

  it('emits type:"json" fallback for nodes without a recognized type', () => {
    const out = convertMcpValueSchema({
      description: 'free-form value',
      // 不带 type,MCP 服务器偶发出现这种写法时不应阻塞工具注册
    })
    expect(out).toEqual({ type: 'json', description: 'free-form value' })
  })

  it('forces additionalProperties to explicit boolean on nested object', () => {
    const out = convertMcpValueSchema({
      type: 'object',
      properties: { x: { type: 'number' } },
      // MCP 客户端常省略 additionalProperties;dsh-tools 拒收缺失
    }) as Record<string, unknown>
    expect(out.additionalProperties).toBe(false)
    expect((out.properties as Record<string, unknown>).x).toEqual({
      type: 'number',
    })
  })

  it('preserves additionalProperties:true when MCP server declares it', () => {
    const out = convertMcpValueSchema({
      type: 'object',
      additionalProperties: true,
      properties: {},
    }) as Record<string, unknown>
    expect(out.additionalProperties).toBe(true)
  })

  it('recurses into array items', () => {
    const out = convertMcpValueSchema({
      type: 'array',
      items: { type: 'string' },
      description: 'list of names',
    })
    expect(out).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: 'list of names',
    })
  })

  it('preserves enum and const scalar constraints', () => {
    expect(
      convertMcpValueSchema({ type: 'string', enum: ['a', 'b', 'c'] }),
    ).toEqual({ type: 'string', enum: ['a', 'b', 'c'] })
    expect(convertMcpValueSchema({ type: 'number', const: 42 })).toEqual({
      type: 'number',
      const: 42,
    })
  })

  it('returns empty map when MCP gives empty/null input', () => {
    expect(mcpInputSchemaToParameterSpec({})).toEqual({})
    expect(mcpInputSchemaToParameterSpec({ properties: {} })).toEqual({})
    // 非 object 输入容错
    // @ts-expect-error 故意注入非法输入
    expect(mcpInputSchemaToParameterSpec(null)).toEqual({})
    // @ts-expect-error 故意注入非法输入
    expect(mcpInputSchemaToParameterSpec('oops')).toEqual({})
  })

  it('produces a parameters spec that dsh-tools defineTool actually accepts (integration)', () => {
    // 这是 fail-before-fix 的核心验证 — 修复前 registerMcpTools 必抛
    // UNSUPPORTED_SCHEMA;修复后 defineTool 应当正常返回 tool 描述符。
    const mcpInput = {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'page URL' },
        depth: { type: 'integer' as const },
      },
      required: ['url'],
    }
    const parameters = mcpInputSchemaToParameterSpec(mcpInput)
    const tool = defineTool({
      name: 'mcp:test:navigate',
      description: 'fake mcp tool',
      parameters,
      output: { schema: { type: 'json' } },
      async execute() {
        return {}
      },
    } as never)
    expect(tool.name).toBe('mcp:test:navigate')
    expect(tool.parameters.type).toBe('object')
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      'url',
      'depth',
    ])
  })
})
