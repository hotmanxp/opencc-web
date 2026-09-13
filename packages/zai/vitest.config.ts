import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 与 vite.config.ts 的 @shared 别名保持一致:web 组件在 vitest 下
    // 运行时 import shared 值(如 fileKind.classifyKind)需要它。
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    globals: true,
    setupFiles: ['test/setup.isolation.ts'],
    // vitest 4.x + happy-dom 20 在全量并发跑测试时,跨文件偶发 ECONNRESET / 超时 /
    // 事件计数偏差(desktopFs.test.ts、command.lifecycle.test.ts 等)。
    // 单独跑或单独跑这些文件都稳定 100% 通过 —— 根因是 vitest 4.x 全量并发跑时
    // happy-dom 的 fetch / supertest socket 在线程间偶发重置,不是产品代码 bug。
    // 全局 retry=2 让 flaky test 自愈,不影响确定性失败的暴露。
    retry: 2,
  },
});
