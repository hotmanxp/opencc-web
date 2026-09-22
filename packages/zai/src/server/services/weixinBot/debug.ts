/**
 * weixin 子系统的调试日志门控(P4)。
 *
 * 长轮询每 35s 一轮,原实现在 hot loop 里无条件 `console.warn` 打
 * payload / response / raw dump —— 生产日志会被刷爆(而且 warn 级别会污染
 * 错误采集)。统一收敛到这里:`ZAI_DEBUG=1` 或 `WEIXIN_DEBUG=1` 才输出。
 *
 * 注意:`console.warn` 仍用于**真错误**(启动失败 / 抛异常 / 桥接告警),不要为了
 * "干净"把这些也吞掉。启动期的**正常稳态**播报(未配置 / 已禁用 / standby /
 * 拉起或复用专用实例)2026-09-22 起也走本门控 —— 每次启动都打会淹掉日志。
 */

export function weixinDebugEnabled(): boolean {
  return process.env.ZAI_DEBUG === '1' || process.env.WEIXIN_DEBUG === '1'
}

/** 低频但不值得默认输出的诊断日志(启动稳态播报 / poll loop / payload dump)。默认静默。 */
export function weixinDiag(message: string, ...rest: unknown[]): void {
  if (!weixinDebugEnabled()) return
  console.warn(message, ...rest)
}
