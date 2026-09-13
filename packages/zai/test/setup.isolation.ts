/**
 * 全局测试隔离:把 ZAI_DATA_DIR 指到每 worker 独立的临时目录。
 *
 * 背景:weixin 持久化存储(SyncBufStore / ContextTokenStore / SessionMap /
 * PairingStore / accounts)的路径函数每次从 env 重读 ZAI_DATA_DIR。此前测试
 * 直写真实 ~/.zai:
 *   1. 跨测试污染 —— 前一个文件留下的 buf/token 让后一个文件的 connect()
 *      行为随运行历史漂移;
 *   2. 触发沙箱 safe-delete 批量删除阈值(同一目录累计 delete > 50)后,
 *      同文件靠后的用例开始随机失败,且只在全量跑时出现。
 *
 * 这里用 worker 级(非 file 级)临时目录:足够隔离,又不至于每个文件重建。
 * 需要"干净状态"的用例自行在 beforeEach 里覆盖(如 WeixinOwnerLock 测试)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.ZAI_DATA_DIR || process.env.ZAI_DATA_DIR.startsWith('/Users/ethan/.zai')) {
  process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-vitest-data-'))
}
