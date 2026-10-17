/**
 * 回归测试 — JSON Schema 的 `required` 语义必须被正确翻译 (wb-005)。
 *
 * JSON Schema 规定:`required` 缺失 = **全部属性可选**;`required` 存在
 * 时,只有列在其中的才是必填。旧实现只在 `required` 存在时才给非必填项加
 * `.optional()`,于是「没有 required」的 schema 全部属性都成了必填。
 *
 * 消费方 `MCPToolAdapter.ts:46` 直接 `safeParse`,后果是:模型省略一个
 * 本来可选的参数 → 校验失败 → 工具调用被拒。MCP server 声明了一堆可选参数
 * 时,这条几乎必然踩到。
 *
 * 判据(计划书给的那条):两份语义等价的 schema,**仅差一个空 `required` 字段**,
 * 转换结果必须一致 —— 现在它们输出相反。
 */
import { describe, expect, it } from 'vitest'
import { jsonSchemaToZod } from '../../../src/compat/mcp/jsonSchemaToZod.js'

describe('jsonSchemaToZod — required 语义 (wb-005)', () => {
  it('没有 required 字段时,全部属性可选', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    }
    const z = jsonSchemaToZod(schema)
    // 省略两个可选参数应当通过
    expect(z.safeParse({}).success).toBe(true)
    expect(z.safeParse({ query: 'x' }).success).toBe(true)
  })

  it('required 为空数组时,同样全部可选(与缺失等价)', () => {
    const withEmptyRequired = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: [],
    }
    expect(jsonSchemaToZod(withEmptyRequired).safeParse({}).success).toBe(true)
  })

  it('两份仅差空 required 字段的 schema 必须产出相同结果', () => {
    const props = { a: { type: 'string' }, b: { type: 'number' } }
    const noRequired = jsonSchemaToZod({ type: 'object', properties: props })
    const emptyRequired = jsonSchemaToZod({
      type: 'object',
      properties: props,
      required: [],
    })
    // 判据本身:两者对空对象的判定必须一致
    expect(noRequired.safeParse({}).success).toBe(emptyRequired.safeParse({}).success)
    expect(noRequired.safeParse({}).success).toBe(true)
  })

  it('required 非空时,列其中的必填、其余可选', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    }
    const z = jsonSchemaToZod(schema)
    expect(z.safeParse({ query: 'x' }).success).toBe(true)
    expect(z.safeParse({ query: 'x', limit: 1 }).success).toBe(true)
    expect(z.safeParse({ limit: 1 }).success, 'required 里的字段仍必须存在').toBe(false)
  })

  it('嵌套 object 里的 required 语义同样正确', () => {
    const schema = {
      type: 'object',
      properties: {
        opts: {
          type: 'object',
          properties: { depth: { type: 'number' } },
        },
      },
      required: ['opts'],
    }
    const z = jsonSchemaToZod(schema)
    expect(z.safeParse({ opts: {} }).success, '内层无 required → depth 可省').toBe(true)
    expect(z.safeParse({}).success).toBe(false)
  })

  it('passthrough 行为不受影响(未知键仍放行)', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    }
    const z = jsonSchemaToZod(schema)
    expect(z.safeParse({ a: 'x', extra: 1 }).success).toBe(true)
  })
})
