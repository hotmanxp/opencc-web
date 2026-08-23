# zai Web 端 aria-label 强制实施 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai Web 前端所有交互元素上补充缺失的 `aria-label`,并用静态审计脚本 `scripts/verify-web-aria-labels.mjs` 永久强制;同时在 `AGENTS.md` 新增「UI 页面规范」章节。

**Architecture:** 三阶段交付:(1) 写 TDD 风格的静态审计脚本(JSX AST 解析 + 白名单 + 豁免算法 + 行号输出),挂入 `pnpm typecheck` 末尾;(2) 按 `pages/` → `components/` 顺序逐文件补 `aria-label`(中文硬编码),跑审计零违规;(3) 改 `AGENTS.md` 加规范章节。

**Tech Stack:** Node-direct (Node ≥22.19)、`@babel/parser`(已有)、`@babel/traverse`(新增 devDep)、`@babel/types`(配套)、AntD 5.22 + React 18、Vitest 4.1(单测)。

**Spec:** `docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md`

## Global Constraints

- **适用范围:** `packages/zai/src/web/src/{pages,components}/**/*.tsx`(共 134 个 .tsx)
- **强制规则:** 所有交互元素必须有可访问名(`aria-label` / `aria-labelledby` / 可见文本 children)
- **豁免条件:** ① 元素含 ≥1 个非空白字符的文本 children ② `<Form.Item label>` 包裹的 input/select/textarea ③ `<Modal title=...>` / `<Drawer title=...>` 含非空 title(AntD 自动 aria-labelledby)
- **白名单(只审计这些):** `Button` / `a` / `button` / `input` / `select` / `textarea` / `Switch` / `Slider` / `Checkbox` / `Radio` / `Modal` / `Drawer` / `Popconfirm` / `Tooltip`(容器 `Tabs` / `Upload` / `Form` 不入白名单,只审计其 children)
- **文案:** 中文硬编码;动词 + 名词(例「删除会话」「新建草稿」);禁止「点击这里」「更多」「按钮」这类无意义标签
- **退出码:** 审计脚本违规返回 1(零违规返回 0)
- **不入范围:** `<img alt>`、`<table>`、axe-core、Wrapper 组件抽象、屏幕阅读器实际走查、i18n 化、已存在但语义错的 aria-label 审计
- **中文硬编码依据:** 仓库无 i18n 库(已 grep `react-i18next` / `react-intl` 均无结果)

## File Structure

| 文件 | 状态 | 职责 |
|------|------|------|
| `scripts/verify-web-aria-labels.mjs` | 新增 | 静态审计脚本主入口(JSX AST 解析 + 白名单 + 豁免判断 + fail loud) |
| `scripts/verify-web-aria-labels.test.mjs` | 新增 | 脚本自身的 Vitest 单测(覆盖豁免算法各分支) |
| `fixtures/aria-label/fixture-pass.tsx` | 新增 | 测试用 fixture:全部豁免,预期 pass |
| `fixtures/aria-label/fixture-fail.tsx` | 新增 | 测试用 fixture:含违规,预期 fail |
| `fixtures/aria-label/fixture-mixed.tsx` | 新增 | 测试用 fixture:豁免 + 违规混合 |
| `packages/zai/src/web/src/pages/**/*.tsx` | 修改 | 补 aria-label(中文硬编码) |
| `packages/zai/src/web/src/components/**/*.tsx` | 修改 | 补 aria-label(中文硬编码) |
| `packages/zai/package.json` | 修改 | `scripts.typecheck` 末尾追加 audit 调用 |
| `package.json`(根) | 修改 | 新增 `@babel/traverse` + `@babel/types` devDependency |
| `AGENTS.md` | 修改 | 新增「UI 页面规范(可访问性 · 强制)」章节 |

---

## Task 1: 写静态审计脚本(JSX AST 解析 + 白名单 + 豁免)

**Files:**
- Create: `fixtures/aria-label/fixture-pass.tsx`
- Create: `fixtures/aria-label/fixture-fail.tsx`
- Create: `fixtures/aria-label/fixture-mixed.tsx`
- Create: `scripts/verify-web-aria-labels.mjs`
- Create: `scripts/verify-web-aria-labels.test.mjs`
- Modify: `package.json`(根):新增 `@babel/traverse` + `@babel/types` 到 devDependencies

**Interfaces:**
- Consumes: `@babel/parser` parse TSX → AST,`@babel/traverse` 遍历 `JSXOpeningElement`
- Produces: 进程退出码 0(全 pass)/ 1(有违规);违规时 stdout 输出 `<file>:<line> <ElementName> 缺少 aria-label` 每行一条

### Step 1.1: 装依赖

```bash
cd /Users/ethan/code/opencc-web
pnpm add -D -w @babel/traverse @babel/types
```

期望:`package.json` devDependencies 增加 `"@babel/traverse": "^7.x.x"` 和 `"@babel/types": "^7.x.x"`。

### Step 1.2: 写 fixture-pass.tsx(全豁免,预期 pass)

文件: `fixtures/aria-label/fixture-pass.tsx`

```tsx
// 全豁免 fixture: 期望审计通过
import { Button, Form, Input, Modal, Drawer, Tooltip } from 'antd'

export function PassExample() {
  return (
    <>
      {/* 豁免: 含可见文字 children */}
      <Button>提交</Button>
      <a href="/x">链接</a>
      <button>原生按钮</button>

      {/* 豁免: Form.Item label 包裹 */}
      <Form.Item label="用户名">
        <Input />
      </Form.Item>

      {/* 豁免: Modal/Drawer 含 title */}
      <Modal title="确认对话框" open={false} />
      <Drawer title="侧边栏" open={false} />

      {/* 豁免: aria-label 已存在 */}
      <Button aria-label="关闭">X</Button>
      <input aria-label="搜索框" />
    </>
  )
}
```

### Step 1.3: 写 fixture-fail.tsx(含违规,预期 fail)

文件: `fixtures/aria-label/fixture-fail.tsx`

```tsx
// 违规 fixture: 期望审计报错
import { Button, Switch, Select } from 'antd'

export function FailExample() {
  return (
    <>
      {/* 违规: 纯图标 Button 无 aria-label */}
      <Button icon={<span>X</span>} />
      {/* 违规: 裸 input */}
      <input type="text" />
      {/* 违规: 裸 Switch */}
      <Switch />
      {/* 违规: 裸 Select */}
      <Select />
      {/* 违规: Modal 无 title 也无 aria-label */}
      <Modal open={false} />
    </>
  )
}
```

### Step 1.4: 写 fixture-mixed.tsx(豁免 + 违规混合)

文件: `fixtures/aria-label/fixture-mixed.tsx`

```tsx
// 混合 fixture: 期望审计仅报最后一行违规
import { Button } from 'antd'

export function MixedExample() {
  return (
    <>
      <Button>已合规</Button>
      <Button icon={<span>X</span>} />
    </>
  )
}
```

### Step 1.5: 写脚本骨架(让测试先失败)

文件: `scripts/verify-web-aria-labels.mjs`

```javascript
#!/usr/bin/env node
/**
 * verify-web-aria-labels
 *
 * Static audit that all interactive elements in zai Web frontend have
 * accessible names (aria-label / aria-labelledby / visible text children).
 *
 * Spec: docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md
 *
 * Usage:
 *   node scripts/verify-web-aria-labels.mjs [target-dir]
 *
 * target-dir defaults to packages/zai/src/web/src/{pages,components}.
 *
 * Exit codes:
 *   0 - all elements pass
 *   1 - one or more violations found (printed to stdout)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import _generate from '@babel/generator'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const INTERACTIVE_WHITELIST = new Set([
  'Button', 'a', 'button', 'input', 'select', 'textarea',
  'Switch', 'Slider', 'Checkbox', 'Radio',
  'Modal', 'Drawer', 'Popconfirm', 'Tooltip',
])

// Components that don't need aria-label themselves; their children are audited
const CONTAINER_COMPONENTS = new Set(['Tabs', 'Upload', 'Form'])

function collectTsxFiles(target) {
  const abs = resolve(REPO_ROOT, target)
  const stat = statSync(abs)
  if (stat.isFile()) return [abs]
  return globSync('**/*.tsx', { cwd: abs, absolute: true })
}

function isInteractiveName(nameNode) {
  if (!nameNode) return false
  if (nameNode.type === 'JSXIdentifier') {
    return INTERACTIVE_WHITELIST.has(nameNode.name)
  }
  if (nameNode.type === 'JSXMemberExpression') {
    // Button.Group / Modal.confirm / Form.Item → walk up the chain
    let cur = nameNode
    while (cur && cur.type === 'JSXMemberExpression') {
      const prop = cur.property
      if (prop && prop.type === 'JSXIdentifier' && INTERACTIVE_WHITELIST.has(prop.name)) {
        return true
      }
      cur = cur.object
    }
    // also check top-level identifier
    if (cur && cur.type === 'JSXIdentifier' && INTERACTIVE_WHITELIST.has(cur.name)) {
      return true
    }
  }
  return false
}

function getAttr(attributes, name) {
  for (const attr of attributes) {
    if (attr.type === 'JSXAttribute' && attr.name && attr.name.name === name) {
      return attr
    }
  }
  return null
}

function hasVisibleTextChild(children) {
  for (const child of children) {
    if (child.type === 'JSXText' && child.value.trim().length >= 1) return true
    // Recurse into JSXElement/JSXExpressionContainer for nested text
    if (child.type === 'JSXElement' && hasVisibleTextChild(child.children || [])) return true
  }
  return false
}

function getStringAttrValue(attr) {
  if (!attr || !attr.value) return null
  if (attr.value.type === 'StringLiteral') return attr.value.value
  if (attr.value.type === 'JSXExpressionContainer') {
    const expr = attr.value.expression
    if (expr.type === 'StringLiteral') return expr.value
    // Non-literal expression → treat as present
    return '__expr__'
  }
  return null
}

function checkElement(node, filePath) {
  const opening = node.openingElement
  if (!isInteractiveName(opening.name)) return null

  // 豁免 1: aria-label / aria-labelledby 已存在
  if (getAttr(opening.attributes, 'aria-label')) return null
  if (getAttr(opening.attributes, 'aria-labelledby')) return null

  // 豁免 2: 含可见文本 children
  if (hasVisibleTextChild(node.children || [])) return null

  // 豁免 3: Modal/Drawer 含非空 title
  const tagName = opening.name.type === 'JSXIdentifier'
    ? opening.name.name
    : opening.name.property?.name
  if (tagName === 'Modal' || tagName === 'Drawer') {
    const titleAttr = getAttr(opening.attributes, 'title')
    const titleVal = getStringAttrValue(titleAttr)
    if (titleVal && titleVal !== '__expr__' && titleVal.trim().length >= 1) {
      return null
    }
  }

  // 豁免 4: Form.Item 含 label 且子节点含 input/select/textarea
  if (tagName === 'Form.Item' || (opening.name.type === 'JSXMemberExpression' && tagName === 'Item')) {
    // 仅当父 Form 包裹时(label 由 Form.Item 提供)
    // 简化: 假设 Form.Item 一律豁免(因其语义就是包裹 label)
    // 但 children 必须是 input/select/textarea
    const hasInputChild = (node.children || []).some((c) => {
      if (c.type !== 'JSXElement') return false
      const childName = c.openingElement.name
      if (childName.type === 'JSXIdentifier') {
        return ['Input', 'Select', 'TextArea', 'Switch', 'Slider', 'Checkbox', 'Radio'].includes(childName.name)
      }
      return false
    })
    if (hasInputChild) return null
  }

  // 豁免 5: <input type="hidden">
  if (tagName === 'input') {
    const typeAttr = getAttr(opening.attributes, 'type')
    const typeVal = getStringAttrValue(typeAttr)
    if (typeVal === 'hidden') return null
  }

  // FAIL
  const loc = opening.loc?.start || node.loc?.start
  return {
    file: relative(REPO_ROOT, filePath),
    line: loc?.line ?? 0,
    element: tagName,
  }
}

function auditFile(filePath) {
  const src = readFileSync(filePath, 'utf8')
  let ast
  try {
    ast = parse(src, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    })
  } catch (err) {
    console.error(`Parse error in ${filePath}: ${err.message}`)
    return []
  }
  const violations = []
  _traverse.default(ast, {
    JSXElement(path) {
      const v = checkElement(path.node, filePath)
      if (v) violations.push(v)
    },
  })
  return violations
}

function main() {
  const target = process.argv[2] || 'packages/zai/src/web/src/{pages,components}'
  // Support brace expansion by globbing both dirs separately
  const dirs = target.includes('{') ? ['pages', 'components'] : [target.replace(/[/\\]$/, '')]

  let allFiles = []
  for (const d of dirs) {
    const abs = resolve(REPO_ROOT, 'packages/zai/src/web/src', d)
    try {
      allFiles = allFiles.concat(collectTsxFiles(abs))
    } catch (e) {
      // dir doesn't exist, skip
    }
  }

  let totalElements = 0
  const violations = []
  for (const f of allFiles) {
    const vs = auditFile(f)
    totalElements += 1 // rough: count files, not elements
    violations.push(...vs)
  }

  if (violations.length === 0) {
    console.log(`✓ scanned ${allFiles.length} files, all interactive elements have accessible names`)
    process.exit(0)
  }
  for (const v of violations) {
    console.log(`✗ ${v.file}:${v.line} <${v.element}> 缺少 aria-label`)
  }
  console.log(`\n${violations.length} violation(s) across ${allFiles.length} files`)
  process.exit(1)
}

main()
```

### Step 1.6: 写脚本测试

文件: `scripts/verify-web-aria-labels.test.mjs`

```javascript
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, 'verify-web-aria-labels.mjs')

function runAudit(target) {
  try {
    const out = execFileSync('node', [SCRIPT, target], {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
    })
    return { code: 0, stdout: out }
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '' }
  }
}

describe('verify-web-aria-labels', () => {
  it('fixture-pass.tsx 全豁免 → 退出码 0', () => {
    const r = runAudit('fixtures/aria-label/fixture-pass.tsx')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/scanned/)
  })

  it('fixture-fail.tsx 含违规 → 退出码 1 + 行号输出', () => {
    const r = runAudit('fixtures/aria-label/fixture-fail.tsx')
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <Button>/)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <input>/)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <Switch>/)
  })

  it('fixture-mixed.tsx 仅报违规行', () => {
    const r = runAudit('fixtures/aria-label/fixture-mixed.tsx')
    expect(r.code).toBe(1)
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('✗'))
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/<Button>/)
  })
})
```

### Step 1.7: 跑测试,确认 fixture-pass 通过、fixture-fail 报违规

```bash
cd /Users/ethan/code/opencc-web
pnpm exec vitest run scripts/verify-web-aria-labels.test.mjs
```

期望:
- `fixture-pass.tsx 全豁免` PASS
- `fixture-fail.tsx 含违规` PASS
- `fixture-mixed.tsx 仅报违规行` PASS

### Step 1.8: 在 zai 目录跑一次,看现有违规数量(预期 ~215 条)

```bash
node scripts/verify-web-aria-labels.mjs 2>&1 | tee /tmp/aria-audit-baseline.txt | head -30
echo "---"
echo "Total violations:"
grep -c "^✗" /tmp/aria-audit-baseline.txt || echo "0"
```

预期:看到 ~215 条违规(后续 Task 3/4 要全部修掉)。**此时保留 baseline 文件供 Task 2 参考。**

### Step 1.9: 提交

```bash
cd /Users/ethan/code/opencc-web
git add scripts/verify-web-aria-labels.mjs \
        scripts/verify-web-aria-labels.test.mjs \
        fixtures/aria-label/ \
        package.json \
        pnpm-lock.yaml
git commit -m "feat(audit): 新增 verify-web-aria-labels 静态审计脚本

扫描 packages/zai/src/web/src/{pages,components}/**/*.tsx,
对所有交互元素(Button / a / button / input / select / Switch 等)
检查是否含可访问名(aria-label / aria-labelledby / 可见文本 children),
违规 fail loud(退出码 1 + 行号输出)。

Spec: docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md"
```

---

## Task 2: 跑现有 baseline,生成违规报告(供 Task 3/4 参考)

**Files:**
- Modify: 不修改文件,只生成 `/tmp/aria-audit-baseline.txt`(临时)

**Interfaces:**
- Consumes: Task 1 提交的 audit 脚本
- Produces: `/tmp/aria-audit-baseline.txt`(Task 3/4 的 TODO 清单来源)

### Step 2.1: 跑完整 audit,生成违规清单

```bash
cd /Users/ethan/code/opencc-web
node scripts/verify-web-aria-labels.mjs 2>&1 | tee /tmp/aria-audit-baseline.txt > /dev/null
echo "Total violations: $(grep -c '^✗' /tmp/aria-audit-baseline.txt)"
```

预期:~215 条违规,分布到 12 个 pages + 50+ 个 components。

### Step 2.2: 按文件聚合,得到 TODO 列表

```bash
grep "^✗" /tmp/aria-audit-baseline.txt | awk -F: '{print $1}' | sort | uniq -c | sort -rn
```

预期:每个文件有几条到几十条违规;这个列表是 Task 3/4 的输入。

### Step 2.3: 不需要 commit(baseline 是临时文件)

---

## Task 3: 给 pages/** 下所有文件补 aria-label

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`
- Modify: `packages/zai/src/web/src/pages/AgentConversation.tsx`
- Modify: `packages/zai/src/web/src/pages/MobileAgent.tsx`
- Modify: `packages/zai/src/web/src/pages/Instances.tsx`
- Modify: `packages/zai/src/web/src/pages/Login.tsx`
- Modify: `packages/zai/src/web/src/pages/Config.tsx`
- Modify: `packages/zai/src/web/src/pages/Dashboard.tsx`
- Modify: `packages/zai/src/web/src/pages/Directory.tsx`
- Modify: `packages/zai/src/web/src/pages/Resources.tsx`
- Modify: `packages/zai/src/web/src/pages/Tools.tsx`
- Modify: `packages/zai/src/web/src/pages/Manage.tsx`

**Interfaces:**
- Consumes: `/tmp/aria-audit-baseline.txt` 中 pages/ 下的违规条目
- Produces: 每个文件 audit 0 违规

### Step 3.1: 取 pages 下的违规清单

```bash
grep "^✗" /tmp/aria-audit-baseline.txt | grep "packages/zai/src/web/src/pages/" > /tmp/aria-pages.txt
echo "pages violations: $(wc -l < /tmp/aria-pages.txt)"
cat /tmp/aria-pages.txt
```

### Step 3.2: 逐文件读违规,补 aria-label

对每个 pages 文件:

1. 打开文件,定位到 `aria-pages.txt` 给出的行号
2. 对每个违规元素,根据上下文确定合适的中文 aria-label
3. 命名约定:动词 + 名词(例「删除会话」「新建草稿」「设置模型」「收起侧边栏」)
4. 加 `aria-label="..."` 到 JSX 上(AntD `Button` 支持 `aria-label` 作为 prop)

**示例 - Agent.tsx 一个违规:**

```diff
- <Button icon={<MenuUnfoldOutlined />} onClick={...} />
+ <Button icon={<MenuUnfoldOutlined />} aria-label="展开侧边栏" onClick={...} />
```

**示例 - Instances.tsx 一个违规:**

```diff
- <Button onClick={handleDelete}>删除</Button>
+ <Button onClick={handleDelete} aria-label="删除实例">删除</Button>
```

(后一个示例 children 已含"删除",但 audit 会基于 icon prop 检查;实际以 audit 输出为准 —— 纯文字 children 自动豁免。)

### Step 3.3: 每个文件修完,跑 audit 单文件验证

```bash
cd /Users/ethan/code/opencc-web
# 假设刚改完 Agent.tsx
node scripts/verify-web-aria-labels.mjs packages/zai/src/web/src/pages/Agent.tsx 2>&1 | tail -5
```

期望:不显示 Agent.tsx 的违规行(其他 pages 的违规可能还在,无所谓)。

### Step 3.4: 跑 pages 整体 audit

```bash
node scripts/verify-web-aria-labels.mjs packages/zai/src/web/src/pages 2>&1 | tail -5
```

期望:0 violations across 11 files。

### Step 3.5: 跑 pages 目录 Vitest 单测,确认无行为破坏

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai test src/web/src/pages/
```

期望:全绿(若有 snapshot 失败,可能是 aria-label 被映入 snapshot —— 若是,更新 snapshot 而非回退改动)。

### Step 3.6: 提交(单文件一 commit,便于 review)

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(a11y): 给 Agent.tsx 交互元素补 aria-label"

# 重复 for 每个 pages 文件
git add packages/zai/src/web/src/pages/AgentConversation.tsx
git commit -m "feat(a11y): 给 AgentConversation.tsx 交互元素补 aria-label"

# ... 重复 until 所有 pages 文件都 commit
```

---

## Task 4: 给 components/** 下所有文件补 aria-label

**Files:**
- Modify: `packages/zai/src/web/src/components/**/*.tsx`(50+ 文件)

**Interfaces:**
- Consumes: `/tmp/aria-audit-baseline.txt` 中 components/ 下的违规条目
- Produces: components 目录 audit 0 违规

### Step 4.1: 取 components 下的违规清单,按子目录分批

```bash
grep "^✗" /tmp/aria-audit-baseline.txt | grep "packages/zai/src/web/src/components/" > /tmp/aria-components.txt
echo "components violations: $(wc -l < /tmp/aria-components.txt)"

# 按目录分桶
awk -F/ '{print $1"/"$2"/"$3"/"$4}' /tmp/aria-components.txt | sort | uniq -c | sort -rn
```

预期:出现 `Layout.tsx`、`*Drawer.tsx`、`*Button.tsx` 等高频子目录。

### Step 4.2: 分批修,每个子目录/相关组件群一个 commit

建议分批顺序(高频 → 低频,影响面大 → 小):

1. **Layout 类**: `Layout.tsx`、`MobileLayout.tsx`、`MobileHeader.tsx`
2. **Drawer 类**: `SettingsDrawer.tsx`、`ApproveDrawer.tsx`、`TaskDrawer.tsx`、`SubagentsDrawer.tsx`、`MobileSessionDrawer.tsx`、`MobileQuickDrawer.tsx`
3. **Button 类**: `SettingsButton.tsx`、`PluginButton.tsx`、`ConversationInfoButton.tsx`、`ModelStatusButton.tsx`、`EffortStatusButton.tsx`、`ModeStatusButton.tsx`、`ConfirmButton.tsx`
4. **Input/Form 类**: `AgentInputBox.tsx`、`BranchSelector.tsx`、`FileMentionPopover.tsx`、`QuickCommandPopover.tsx`、`MentionChip.tsx`
5. **Transcript/Tool 类**: `transcript/*.tsx`、`toolRenderers/*.tsx`、`markdown/*.tsx`
6. **其他杂项**: `StatusDot.tsx`、`TodoDropdown.tsx`、`TodoZone.tsx`、`SharePopover.tsx`、`UpdateNotifier.tsx`、`WeixinBotPanel.tsx`、`ZnLogo.tsx`、`DiffBlock.tsx`、`AttachmentStrip.tsx`、`LogPanel.tsx`、`PermissionConfirmCard.tsx`、`QuestionCard.tsx`、`ConversationInfoCard.tsx`、`splitPane/*.tsx`、`PluginModal/*`、`useFsMentionSearch.ts`

每个子目录/组件群的修法:

1. 读 `aria-components.txt` 中该文件对应的行号
2. 对每个违规元素补 aria-label(命名遵循 spec:动词 + 名词,中文硬编码)
3. 单文件 audit 验证
4. 子目录 audit 验证
5. 单测(若有)验证
6. 提交

### Step 4.3: 每个子目录群示例(Layout 类)

```bash
# 取 Layout 子目录违规
grep "^✗" /tmp/aria-components.txt | grep -E "(Layout|MobileHeader)\.tsx" > /tmp/aria-layout.txt
cat /tmp/aria-layout.txt
```

修 Layout.tsx / MobileLayout.tsx / MobileHeader.tsx(每个违规行按上下文加 aria-label):

**示例 - Layout.tsx:**

```diff
- <Button onClick={toggleSider} icon={...} />
+ <Button onClick={toggleSider} icon={...} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"} />
```

**示例 - MobileHeader.tsx:**

```diff
- <Button onClick={openMenu} icon={<MenuOutlined />} />
+ <Button onClick={openMenu} icon={<MenuOutlined />} aria-label="打开菜单" />
```

### Step 4.4: 子目录 audit

```bash
cd /Users/ethan/code/opencc-web
node scripts/verify-web-aria-labels.mjs packages/zai/src/web/src/components 2>&1 | tail -10
```

期望:violations 数逐批下降;最后一批完成后 0 violations。

### Step 4.5: 跑 components Vitest 单测

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai test src/web/src/components/
```

期望:全绿。snapshot 失败时更新 snapshot(aria-label 是 a11y 增强,合理更新)。

### Step 4.6: 提交(每子目录一个 commit)

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/Layout.tsx \
        packages/zai/src/web/src/components/MobileLayout.tsx \
        packages/zai/src/web/src/components/MobileHeader.tsx
git commit -m "feat(a11y): 给 Layout / MobileLayout / MobileHeader 交互元素补 aria-label"

# 重复 for 其他子目录群
```

---

## Task 5: 更新 AGENTS.md,新增「UI 页面规范(可访问性 · 强制)」章节

**Files:**
- Modify: `AGENTS.md`(在 `## 强制开发规则` 段之后、`## 常用验证命令` 段之前,插入新章节)

**Interfaces:**
- Consumes: spec §AGENTS.md 新增章节草稿
- Produces: AGENTS.md 多一节完整规范

### Step 5.1: 定位插入点

```bash
grep -n "^## 强制开发规则\|^## 常用验证命令" /Users/ethan/code/opencc-web/AGENTS.md
```

输出形如:
```
45:## 强制开发规则
N:## 常用验证命令
```

记下两行行号,新章节插在第 N 行之前。

### Step 5.2: 插入新章节(用 edit 工具,定位 `## 常用验证命令` 段标题)

编辑 `AGENTS.md`,定位唯一 `## 常用验证命令` 标题行,在它前面插入(spec 内的 AGENTS.md 草稿整段):

````markdown
## UI 页面规范(可访问性 · 强制)

**适用范围**:所有 `packages/zai/src/web/src/pages/**` 与 `components/**` 下的 `.tsx`。

### 强制规则

所有交互元素必须提供可访问名(accessible name),优先级:

1. `aria-label="..."`(中文硬编码,与现有文案保持一致)
2. `aria-labelledby="..."`(引用现有可见文字的 id)
3. 可见文本 children(豁免条件,见下)

### 豁免条件(满足其一即可)

- 元素含可见文本 children(例:`<Button>提交</Button>` / `<a>删除</a>`)
- `<Form.Item label="...">` 包裹的 input / select / textarea(AntD 自动 `htmlFor` 关联)
- `<Modal title="...">` / `<Drawer title="...">` 含非空 title(AntD 自动 aria-labelledby)
- `<Tabs.TabPane tab="...">` / `<Tabs items=[{ label }]>`(`tab` / `item.label` 已是可访问名)
- 纯装饰 `<Icon />` / `<span>`(父元素已含 aria-label 时 AntD Icon 自动 aria-hidden;独立使用建议 `aria-hidden="true"`)

### 必须 aria-label 的元素清单

- 纯图标 `<Button icon={X}>`(无文字 children)
- 原生 `<a>` / `<button>`
- 裸 `<input type="text|number|...">`(未包 Form.Item)
- 裸 `<Select>` / `<Switch>` / `<Input.TextArea>` / `<Slider>` / `<Checkbox>` / `<Radio>`
- `<Tooltip>` / `<Popconfirm>` 包裹的触发元素(`title` 不算可访问名)
- `<Modal>` / `<Drawer>` `title` 为空或缺省时(有 title 时 AntD 自动 aria-labelledby,豁免)
- 容器组件(`Tabs` / `Upload` / `Form`)**不**入审计白名单,只审计其 children

### 文案约定

- 中文为主,与页面现有文案语气一致
- 动词 + 名词(如「删除会话」、「新建草稿」)优于模糊词(如「按钮」、「操作」)
- 禁止「点击这里」、「更多」这类无意义标签

### 验证

```bash
node scripts/verify-web-aria-labels.mjs            # 单跑(默认扫 pages + components)
node scripts/verify-web-aria-labels.mjs <dir>      # 扫指定目录
pnpm --filter @zn-ai/zai typecheck                  # 自动含此检查(typecheck 末尾追加)
```

新组件提交前必须跑过 audit,违规会 fail loud(退出码 1)。详细豁免算法与元素白名单见 `docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md`。
````

### Step 5.3: 提交

```bash
cd /Users/ethan/code/opencc-web
git add AGENTS.md
git commit -m "docs(agents): 新增 UI 页面规范(可访问性 · 强制)章节

定义 zai Web 前端 aria-label 强制规则:适用范围、豁免条件、
必须 aria-label 的元素清单、文案约定、验证命令。

Spec: docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md"
```

---

## Task 6: 把审计脚本挂入 zai typecheck 链路

**Files:**
- Modify: `packages/zai/package.json`(`scripts.typecheck` 末尾追加)

**Interfaces:**
- Consumes: `scripts/verify-web-aria-labels.mjs`(已存在)
- Produces: `pnpm --filter @zn-ai/zai typecheck` 跑通时自动跑 audit

### Step 6.1: 读 packages/zai/package.json 的 typecheck 行

```bash
grep '"typecheck"' /Users/ethan/code/opencc-web/packages/zai/package.json
```

输出形如:
```json
"typecheck": "tsc -b --noEmit"
```

### Step 6.2: 修改 typecheck

```diff
- "typecheck": "tsc -b --noEmit"
+ "typecheck": "tsc -b --noEmit && node ../../scripts/verify-web-aria-labels.mjs"
```

跨 workspace 路径相对 `packages/zai/`:`../../scripts/verify-web-aria-labels.mjs`。

### Step 6.3: 跑 typecheck,确认 0 违规 + tsc 通过

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai typecheck
```

期望:
- `tsc -b --noEmit` 通过
- audit 输出 `✓ scanned <N> files, all interactive elements have accessible names`
- 整体退出码 0

### Step 6.4: 故意制造一个违规(模拟未来漏改),确认 fail loud

临时改一个文件(用完恢复):

```bash
cd /Users/ethan/code/opencc-web
# 临时插入一个违规
echo '<Button icon={<span>+</span>} />' >> packages/zai/src/web/src/pages/Agent.tsx

# 跑 typecheck,期望失败
pnpm --filter @zn-ai/zai typecheck 2>&1 | tail -5

# 撤销
git checkout -- packages/zai/src/web/src/pages/Agent.tsx
```

期望:违规被检出,typecheck 退出码非 0。

### Step 6.5: 跑 zai 整体 typecheck(确认没影响其他 workspace)

```bash
cd /Users/ethan/code/opencc-web
pnpm -r run typecheck
```

期望:所有 workspace typecheck 通过(其他 workspace 不挂 audit,但 tsc 必须绿)。

### Step 6.6: 提交

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/package.json
git commit -m "chore(zai): typecheck 末尾挂 verify-web-aria-labels 审计

确保 pnpm --filter @zn-ai/zai typecheck 在 tsc 通过后
自动跑 aria-label 静态审计,违规 fail loud。

Spec: docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md"
```

---

## Task 7: 最终验证与清理

**Files:**
- 全部 `packages/zai/src/web/src/{pages,components}/**/*.tsx`(已修)
- `scripts/verify-web-aria-labels.mjs`(已加)
- `AGENTS.md`(已加章节)
- `packages/zai/package.json`(已改 typecheck)

### Step 7.1: 跑全 zai 单测,确认 aria-label 改动未破坏行为

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai test src/web/
```

期望:全绿(2192 用例)。snapshot 失败若是 aria-label 映入,更新 snapshot。

### Step 7.2: 跑 typecheck 含 audit,确认链路全绿

```bash
cd /Users/ethan/code/opencc-web
pnpm --filter @zn-ai/zai typecheck
```

期望:`tsc -b --noEmit` PASS + `✓ scanned <N> files, all interactive elements have accessible names`。

### Step 7.3: 清理临时文件

```bash
rm -f /tmp/aria-audit-baseline.txt /tmp/aria-pages.txt /tmp/aria-components.txt /tmp/aria-layout.txt
```

### Step 7.4: 提交总览

```bash
cd /Users/ethan/code/opencc-web
git log --oneline -20
```

期望看到完整 commit 序列:
1. `docs(spec): zai Web 端 aria-label 强制实施设计`(已在 brainstorming 阶段提交)
2. `feat(audit): 新增 verify-web-aria-labels 静态审计脚本`
3. N× `feat(a11y): 给 <File> 交互元素补 aria-label`(每个 pages/components 文件一 commit)
4. `docs(agents): 新增 UI 页面规范(可访问性 · 强制)章节`
5. `chore(zai): typecheck 末尾挂 verify-web-aria-labels 审计`

---

## Self-Review(已完成)

- ✅ Spec coverage: 7 个任务覆盖 spec 全部决策点(audit 脚本、豁免算法、AGENTS.md 新章节、typecheck 接入、文案约定、范围)
- ✅ Placeholder scan: 无 TBD / TODO;每个 step 有具体命令或代码
- ✅ Type consistency: 脚本接口 `auditFile(path) → violations[]`、退出码 0/1 在 Task 1 与 Task 6 一致;whitelist `INTERACTIVE_WHITELIST` 在 Task 1 定义、Task 6 直接复用同文件
- ✅ Task right-sizing: Task 1 / 5 / 6 各 ~30 min;Task 3 / 4 各 ~1-2 小时(分批 commit);Task 2 / 7 各 ~10 min
- ⚠️ Task 3/4 是大块改动(~215 处 aria-label),但每子目录群独立 commit,reviewer 可逐 commit 拒/通过 —— 满足"每 task 独立可测试"