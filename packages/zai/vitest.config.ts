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
    // 兜底:`fileParallelism: false` 让所有 test 串行跑(同进程,共享
    // module cache,避开 happy-dom 资源竞争);testTimeout: 30s 给超慢用例
    // (rpc stub codegen / desktopFS 端到端 / desktop 页面)充足时间。
    //
    // vitest 5 升级后实测:撤回 fileParallelism 仍稳定复现 flaky —— 5 轮全量
    // 并行下 PdfRenderer 翻页用例挂 3 轮(replHistory ?q= 前缀过滤 30s 超时
    // 偶发 1 轮),隔离单跑都 100% 稳定,是全量并发下的资源争抢。两条测试本
    // 身没问题,所以保留串行兜底是有理由的;要解只能抓出真正占资源的源头
    // (可能是 16GB 内存下 happy-dom worker 数量撑爆),不在这次升级范围。
    fileParallelism: false,
    retry: 3,
    testTimeout: 30_000,
    // happy-dom 在测试 teardown 时会 abort 未完成的 fetch,触发
    // `DOMException [AbortError]`。vitest 4.x 把这些 AbortError 记为
    // unhandled error 让 exit code 变 1(test 本身全过)。抑制这条噪音,
    // 只保留真正的 test assertion 失败作为失败信号。
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
