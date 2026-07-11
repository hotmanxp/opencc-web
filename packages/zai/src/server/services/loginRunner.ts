import { spawn } from '../services/spawner.js';
import type { LoginType, SseEvent } from '../../shared/types.js';

const LOGIN_ARGS: Record<LoginType, string[]> = {
  pa: ['pa'],
  // PA 神兵 ticket 默认 1 天有效；--day 6 申请 6 天有效 ticket（强制重登）
  'pa-long': ['pa', '--day', '6'],
  op: ['op'],
};

export async function runLogin(
  type: LoginType,
  onLine: (event: SseEvent) => void,
): Promise<{ code: number; signal: string | null }> {
  const args = ['-y', '@zn-ai/agent-login@latest', ...LOGIN_ARGS[type]];
  return spawn('npx', args, onLine);
}
