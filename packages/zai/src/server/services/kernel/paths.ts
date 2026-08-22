import { join } from 'node:path';
import { ZAI_DIR } from '../paths.js';

/**
 * 双轨 (dual-track) 数据目录常量 — B0 T0.6。
 *
 * 设计原则（主计划 §4.2）：
 * - 两条轨道（opencc / dsh）**不得互相污染数据**。
 * - dsh 轨道的会话走独立子目录 `dsh-sessions/`，任务走独立 namespace。
 * - 数据隔离是 B0-B7 所有批次的不变量：迁移工具（B6）是唯一允许跨格式读写
 *   的代码，且默认 dry-run。
 *
 * 与 opencc 轨道路径并列，便于排查时一眼看出归属：
 *   ${dataDir}/projects/<cwd>/<sessionId>.jsonl         (opencc 轨道 — 现状)
 *   ${dataDir}/projects/<cwd>/dsh-sessions/<sessionId>/ (dsh 轨道 — 新增)
 *
 * 任务 store：
 *   ~/.zai/tasks/<taskId>.json                          (opencc 轨道 — 现状)
 *   ~/.zai/tasks-dsh/<taskId>.json                      (dsh 轨道 — 新增)
 *
 * 任务 namespace 选「独立子目录」方案而非「前缀方案」，理由：
 * - 子目录是文件系统级隔离，opencc 任务的现有 ID/扫描逻辑完全不受影响；
 * - 前缀方案需要 opencc 侧解析时过滤「dsh-」前缀，容易遗漏导致双轨互读。
 */

export const DSH_KERNEL = 'dsh' as const;
export const OPENCC_KERNEL = 'opencc' as const;
export type KernelId = typeof OPENCC_KERNEL | typeof DSH_KERNEL;

/** dsh 轨道会话目录常量 — 沿用 opencc 的 projects/<cwd>/ 沙箱结构，仅末尾追加 dsh-sessions/。 */
export function dshSessionsDir(dataDir: string, cwd: string): string {
  // 与 opencc 轨道共用同一 cwd 沙箱，但会话格式不兼容，所以放独立子目录。
  // 实际调用方在 services/kernel/factories/dsh.ts 内拼出 sanitized cwd。
  return join(dataDir, 'projects', cwd, 'dsh-sessions');
}

/** dsh 轨道任务 namespace 根目录 — 整段隔离，opencc 任务的现有读写路径不触达。 */
export const DSH_TASKS_DIR = join(ZAI_DIR, 'tasks-dsh');

/**
 * dsh 任务 JSON 文件路径 — 每任务一份，schema 与 opencc 的
 * `~/.zai/tasks/<id>.json` 不兼容，禁止跨文件读取。
 */
export function dshTaskPath(taskId: string): string {
  return join(DSH_TASKS_DIR, `${taskId}.json`);
}

/** 引擎要求常量 — Node >= 22.19（dsh 代码用到 Node 22+ API）。 */
export const DSH_REQUIRED_NODE_MAJOR_MIN = 22;
export const DSH_REQUIRED_NODE_MINOR_MIN = 19;

/**
 * 解析当前进程的 Node 主版本号，避开 `process.versions.node` 字符串解析
 * 时的 `v` 前缀 / patch 版本噪音。
 */
function parseNodeMajorMinor(versionStr: string): { major: number; minor: number } | null {
  // 形如 "v22.22.3" 或 "v24.0.0-nightly20240101"。
  const m = /^v?(\d+)\.(\d+)/.exec(versionStr);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * 当前 Node 版本是否满足 dsh 模式引擎要求（`^22.19.0 || >=24.0.0`）。
 * 用作 `createKernel` 启动前 fail loud 兜底。
 */
export function nodeSupportsDsh(): boolean {
  const parsed = parseNodeMajorMinor(process.versions.node);
  if (!parsed) return false;
  if (parsed.major >= 24) return true;
  if (parsed.major === DSH_REQUIRED_NODE_MAJOR_MIN) {
    return parsed.minor >= DSH_REQUIRED_NODE_MINOR_MIN;
  }
  return false;
}

/**
 * 引擎检查失败时的修复指引 — 启动日志直接输出，B0 T0.4 验收要求。
 * 静态字符串而非 throw，便于 zai-server 启动序列内的 catch + 输出 + exit 1。
 */
export const NODE_VERSION_REPAIR_HINT =
  'zai 进程当前 Node 版本不满足 dsh 内核要求（>= 22.19.0 或 >= 24.0.0）。' +
  '请升级 Node 后重启 zai，或临时在 ~/.zai/settings.json 中设置 ' +
  '"agent": { "kernel": "opencc" } 切回默认内核。';