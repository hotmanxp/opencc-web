/**
 * cwd 有效性判据 —— 「这个路径现在还是一个真实存在的目录吗」。
 *
 * 微信链路三处共用同一判据:
 *   - `weixinDedicatedInstance`:拉起/重启专用实例前校验配置的工作目录;
 *   - `WeixinSessionMap`:会话绑定的 cwd 被删后自愈;
 *   - `weixinInboundBridge`:把绑定 cwd 种子化进 CwdStore 前判空。
 *
 * 为什么必须只有一份实现:三处对"失效目录"的理解一旦漂移,表现就是
 * 「有时能自愈、有时 Bash 永久卡在死目录」这种难复现的偶发。
 *
 * 刻意零依赖(只 node:fs),不 import 任何服务模块 —— 避免被
 * channelProfile 那类"启动早期就要判定"的路径拖出循环依赖。
 */
import { existsSync, statSync } from 'node:fs'

export function isValidDir(path: string): boolean {
  if (!path) return false
  try {
    // realpath 对"存在但是文件"的路径同样成功,必须再确认 isDirectory ——
    // 否则 spawn 会在后面以 ENOTDIR / exit 126 失败。
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    // existsSync 与 statSync 之间存在 TOCTOU 窗口(目录被并发删除)。
    return false
  }
}
