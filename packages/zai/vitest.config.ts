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
    // vitest 4.x 默认 `pool: 'threads'` + happy-dom 20 在 zai 大量测试
    // (304 文件 / 2869 用例) 并发跑时出现严重卡死:跨文件 ECONNRESET / 单
    // test 跑到 40s+ 才 timeout / module-level 单例跨 thread 共享污染。
    // 单独跑任一文件 100% 通过 → 是并发执行的问题,不是产品代码 bug。
    //
    // 兜底:加 `fileParallelism: false` 让所有 test 串行跑(同进程,共享
    // module cache,避开 happy-dom 资源竞争);retry=3 给纯网络侧偶发
    // 问题(单独跑不复现)最后一次兜底。
    fileParallelism: false,
    retry: 3,
    testTimeout: 10_000,
  },
});
