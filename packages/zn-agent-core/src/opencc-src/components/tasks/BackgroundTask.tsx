// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Text } from 'src/ink.js';
import type { BackgroundTaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { truncate } from 'src/utils/format.js';
import { toInkColor } from 'src/utils/ink.js';
import { plural } from 'src/utils/stringUtils.js';
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js';
import { RemoteSessionProgress } from './RemoteSessionProgress.js';
import { ShellProgress, TaskStatusText } from './ShellProgress.js';
import { describeTeammateActivity } from './taskStatusUtils.js';
type Props = {
  task: DeepImmutable<BackgroundTaskState>;
  maxActivityWidth?: number;
};
export function BackgroundTask(t0) {
  return null;
}
