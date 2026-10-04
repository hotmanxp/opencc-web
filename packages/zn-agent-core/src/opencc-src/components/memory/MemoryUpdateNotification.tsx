// @ts-nocheck
import { homedir } from 'os';
import { relative } from 'path';
import { getCwd } from '../../utils/cwd.js';
export function getRelativeMemoryPath(path: string): string {
  const homeDir = homedir();
  const cwd = getCwd();

  // Calculate relative paths
  const relativeToHome = path.startsWith(homeDir) ? '~' + path.slice(homeDir.length) : null;
  const relativeToCwd = path.startsWith(cwd) ? './' + relative(cwd, path) : null;

  // Return the shorter path, or absolute if neither is applicable
  if (relativeToHome && relativeToCwd) {
    return relativeToHome.length <= relativeToCwd.length ? relativeToHome : relativeToCwd;
  }
  return relativeToHome || relativeToCwd || path;
}
export function MemoryUpdateNotification(t0) {
  return null;
}
