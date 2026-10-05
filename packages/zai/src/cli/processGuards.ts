import { logHttp } from '../server/services/accessLog.js'

/**
 * 进程级兜底。拆成独立模块是为了能被测 —— 这层兜底一旦被误删,症状是
 * 「某个请求的 ENOENT 悄悄干掉整个 server」,而症状离原因隔得很远,
 * 没有测试守着的话回归不会有任何征兆。
 *
 * 2026-10-05, bug `async-handler-rejection-kills-process`。zai 跑 Express 4,
 * 它**不**转发 async handler 返回的 rejected promise,于是任何一处漏 catch 的
 * await 都会变成 unhandledRejection;Node 15+ 的默认行为是 `throw` 终止进程 ——
 * 一次请求的 ENOENT/EACCES 就能带走所有会话的 SSE、在跑的 turn 与后台 runtime。
 * index.ts 的 catch-all error handler 对 async 路径完全无效。
 */
export function installProcessGuards(): void {
  // 只记日志、**不退出**:unhandledRejection 绝大多数是「某个 await 挂了」而不是
  // 「进程状态已损坏」,保住进程与其它会话、让受影响的请求降级成 500,明显优于
  // 整服重启。逐路由的 try/catch(R2-c)修的是根因,这层是覆盖面最广的止血。
  //
  // 刻意**不**注册 uncaughtException 后静默继续:同步异常意味着进程状态可能已经
  // 不一致,继续跑是另一个量级的决定,需要单独讨论。
  process.on('unhandledRejection', (reason) => {
    const err = reason as Error | undefined
    logHttp(
      `[zai-fatal] unhandledRejection: ${reason}\n${err?.stack ?? '(no stack — non-Error rejection)'}`,
      'error',
    )
  })
}
