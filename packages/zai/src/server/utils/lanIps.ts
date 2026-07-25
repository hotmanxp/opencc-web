import { networkInterfaces } from 'node:os';

/**
 * 探测本机非 internal 的 IPv4 地址,排重返回。
 * 用途:zai --lan 启动后,在 /api/system 里返回候选 LAN 地址,
 *      前端分享弹层列出,用户挑选复制。
 *
 * 设计:
 * - os.networkInterfaces() 在大多数 OS 上返回 Map<name, NIC[]>
 * - 过滤掉 internal=true 的(loopback 127.0.0.1, ::1)
 * - 只保留 family === 'IPv4' (TypeScript 这里 family 是字符串而非枚举)
 * - 用 Set 去重(某些 OS 同名 interface 多个 v4 address)
 */
export function detectLanIps(): string[] {
  const seen = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const nic of list) {
      if (nic.internal) continue;
      if (nic.family !== 'IPv4') continue;
      seen.add(nic.address);
    }
  }
  return [...seen];
}