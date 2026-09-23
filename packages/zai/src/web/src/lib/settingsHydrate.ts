/**
 * 把 GET /api/agent/settings 返回的数值字段钳位到 [min, max]。
 *
 * 存在的理由有两个：
 *   1. Layout 与 MobileLayout 各要 hydrate 一遍同一批数值设置（现在有
 *      maxVisibleMessages，加 archiveKeepCount），钳位表达式不该抄两份；
 *   2. 给 hydrate 一个可单测的缝合点 —— 不必拉起整个 Layout 就能验证
 *      "手编 settings.json 写出 0/负数/字符串时不会把 NaN 灌进 store"。
 *
 * 返回 null 表示「本次不 hydrate」：字段缺失 / 类型不对时保留 store 现有值，
 * 而不是把 undefined 钳成一个数字。
 */
export function clampSettingNumber(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(min, Math.min(max, Math.floor(value)))
}
