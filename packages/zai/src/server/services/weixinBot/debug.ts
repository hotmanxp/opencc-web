/**
 * weixin 子系统的调试日志门控(P4)。
 *
 * 长轮询每 35s 一轮,原实现在 hot loop 里无条件 `console.warn` 打
 * payload / response / raw dump —— 生产日志会被刷爆(而且 warn 级别会污染
 * 错误采集)。统一收敛到这里:`ZAI_DEBUG=1` 或 `WEIXIN_DEBUG=1` 才输出。
 *
 * 注意:`console.warn` 仍用于**低频**且值得留痕的事件(启动失败 / standby /
 * 状态翻转),不要为了"干净"把真错误也吞掉。
 */

export function weixinDebugEnabled(): boolean {
  return process.env.ZAI_DEBUG === '1' || process.env.WEIXIN_DEBUG === '1'
}

/** 高频诊断日志(poll loop / payload dump)。默认静默。 */
export function weixinDiag(message: string, ...rest: unknown[]): void {
  if (!weixinDebugEnabled()) return
  console.warn(message, ...rest)
}
