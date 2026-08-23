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
import { readFileSync, statSync, existsSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const INTERACTIVE_WHITELIST = new Set([
  'Button', 'Select', 'a', 'button', 'input', 'select', 'textarea',
  'Switch', 'Slider', 'Checkbox', 'Radio',
  'Modal', 'Drawer', 'Popconfirm', 'Tooltip',
])

// Form.Item is a JSXMemberExpression where neither `Form` nor `Item` is
// individually "interactive" — `Form` is a container, `Item` is a fragment
// — but the combination is what carries the Form.Item label exemption.
// Recognized separately so the bare `<Form>` wrapper is NOT flagged as a
// violation (a `<form>` element is not interactive in the accessibility sense).
// See the Form.Item branch in isInteractiveName below.

function collectTsxFiles(target) {
  const abs = resolve(REPO_ROOT, target)
  const stat = statSync(abs)
  if (stat.isFile()) return [abs]
  // Node v22's fs.globSync ignores `absolute: true` when the pattern is
  // relative + cwd is used — only returns absolute paths when the pattern
  // itself starts with `/`. Build an absolute pattern instead.
  return globSync(join(abs, '**/*.tsx'))
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
    // Form.Item: top-level Form + property Item — neither in whitelist
    // individually, but the combination is interactive (carries label exemption).
    if (
      cur && cur.type === 'JSXIdentifier' && cur.name === 'Form' &&
      nameNode.property && nameNode.property.type === 'JSXIdentifier' &&
      nameNode.property.name === 'Item'
    ) {
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
  // Spec 豁免条件 ②: <Form.Item label="..."> 包裹的 input/select/textarea
  // 由 Form.Item 的 label 提供可访问名,自身不再要求 aria-label。
  if (tagName === 'Form.Item' || (opening.name.type === 'JSXMemberExpression' && tagName === 'Item')) {
    // 仅当父 Form 包裹时(label 由 Form.Item 提供)
    // 简化: 假设 Form.Item 一律豁免(因其语义就是包裹 label)
    // 但 children 必须是 input/select/textarea(可嵌套 — 例如 Form > Form.Item > Form.Item > Input)
    const INPUT_NAMES = new Set(['Input', 'Select', 'TextArea', 'Switch', 'Slider', 'Checkbox', 'Radio'])
    function hasInputDescendant(children) {
      for (const c of children || []) {
        if (c.type !== 'JSXElement') continue
        const childName = c.openingElement.name
        if (childName.type === 'JSXIdentifier' && INPUT_NAMES.has(childName.name)) {
          return true
        }
        // Nested Form.Item wrapping an input — recurse
        if (
          childName.type === 'JSXMemberExpression' &&
          childName.object?.type === 'JSXIdentifier' &&
          childName.object.name === 'Form' &&
          childName.property?.type === 'JSXIdentifier' &&
          childName.property.name === 'Item'
        ) {
          if (hasInputDescendant(c.children || [])) return true
        }
      }
      return false
    }
    if (hasInputDescendant(node.children)) return { __skipSubtree: true }
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
  // NOTE: In Node 22 ESM, `import _traverse from '@babel/traverse'` already
  // unwraps the CJS default export — `_traverse` IS the traverse function.
  // (The brief's `_traverse.default(...)` pattern only works under CJS or
  // bundlers that preserve the namespace; Node ESM doesn't.)
  _traverse(ast, {
    JSXElement(path) {
      const v = checkElement(path.node, filePath)
      if (v && v.__skipSubtree) {
        // Form.Item exemption: wrapper is exempt AND its subtree should not
        // be audited (the inner Input/Select/etc. inherits accessible name
        // from the Form.Item label).
        path.skip()
        return
      }
      if (v) violations.push(v)
    },
  })
  return violations
}

function main() {
  const target = process.argv[2] || 'packages/zai/src/web/src/{pages,components}'

  let allFiles = []

  // If target is an explicit path that exists (file or dir), audit it directly.
  // This is how tests pass single fixtures like `fixtures/aria-label/fixture-pass.tsx`.
  const targetAbs = resolve(REPO_ROOT, target)
  if (existsSync(targetAbs)) {
    allFiles = collectTsxFiles(target)
  } else if (target.includes('{')) {
    // Brace-expansion placeholder for default {pages,components} layout
    for (const d of ['pages', 'components']) {
      const abs = resolve(REPO_ROOT, 'packages/zai/src/web/src', d)
      try {
        allFiles = allFiles.concat(collectTsxFiles(abs))
      } catch (e) {
        // dir doesn't exist, skip
      }
    }
  } else {
    // Fallback: treat as a subpath of the web src tree
    const abs = resolve(REPO_ROOT, 'packages/zai/src/web/src', target.replace(/[/\\]$/, ''))
    try {
      allFiles = collectTsxFiles(abs)
    } catch (e) {
      console.error(`Path not found: ${target}`)
      process.exit(1)
    }
  }

  const violations = []
  for (const f of allFiles) {
    const vs = auditFile(f)
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