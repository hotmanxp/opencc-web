// @ts-nocheck
import figures from 'figures';
import * as React from 'react';
import { type Task } from '../utils/tasks.js'
import type { Theme } from '../utils/theme.js';
type Props = {
  tasks: Task[];
  isStandalone?: boolean;
};
const RECENT_COMPLETED_TTL_MS = 30_000;
function byIdAsc(a: Task, b: Task): number {
  const aNum = parseInt(a.id, 10);
  const bNum = parseInt(b.id, 10);
  if (!isNaN(aNum) && !isNaN(bNum)) {
    return aNum - bNum;
  }
  return a.id.localeCompare(b.id);
}
export function TaskListV2({
  tasks,
  isStandalone = false
}: Props): React.ReactNode | null {
  return null;
}
function getTaskIcon(status: Task['status']): {
  icon: string;
  color: keyof Theme | undefined;
} {
  switch (status) {
    case 'completed':
      return {
        icon: figures.tick,
        color: 'success'
      };
    case 'in_progress':
      return {
        icon: figures.squareSmallFilled,
        color: 'claude'
      };
    case 'pending':
      return {
        icon: figures.squareSmall,
        color: undefined
      };
  }
}
function TaskItem(t0) {
  return null;
}
function _temp2(id) {
  return `#${id}`;
}
function _temp(a, b) {
  return parseInt(a, 10) - parseInt(b, 10);
}
