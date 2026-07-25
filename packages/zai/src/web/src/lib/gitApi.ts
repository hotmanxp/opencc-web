import { api } from './api.js';
import type { GitRevertResult } from '../../../../shared/git.js';

export const gitApi = {
  revertFile: (path: string): Promise<GitRevertResult> =>
    api.post<GitRevertResult>('/git/revert', { path }),
};
