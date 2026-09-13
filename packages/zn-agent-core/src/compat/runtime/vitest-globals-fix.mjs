/**
 * vitest setupFile: 把 vitest 命名导出注入 globalThis。
 *
 * Why: vitest.config.ts L139 `globals: true` 在 src/compat/repl/__tests__/
 * 下的 27 个 .test.ts 上没生效 —— `afterAll is not defined` (Failed Suites,
 * 不是单 test 失败)。原因可能是 vitest 2.1.9 + 多 setupFiles + tsx
 * loader 链里某些 tsconfig 配置 (src/opencc-src/tsconfig) 阻断了
 * globals 注入。
 *
 * 直接把 vitest 提供的 hook (afterAll 等) 挂到 globalThis,让 test file
 * 不必每个都 `import { afterAll } from 'vitest'`。这是 vitest 官方文档
 * 推荐的 "load globals manually" 兜底手法。
 */
import * as vitest from 'vitest'

const hooks = ['afterAll', 'afterEach', 'beforeAll', 'beforeEach', 'describe', 'it', 'expect', 'vi', 'test']
for (const name of hooks) {
  if (typeof vitest[name] === 'function' && typeof globalThis[name] === 'undefined') {
    globalThis[name] = vitest[name]
  }
}
