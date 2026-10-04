import { getGlobalConfig } from '../../utils/config.js'
import { isOpus1mMergeEnabled } from '../../utils/model/model.js';
const MAX_SHOW_COUNT = 6;
export function shouldShowOpus1mMergeNotice(): boolean {
  return isOpus1mMergeEnabled() && (getGlobalConfig().opus1mMergeNoticeSeenCount ?? 0) < MAX_SHOW_COUNT;
}
export function Opus1mMergeNotice() {
  return null;
}
