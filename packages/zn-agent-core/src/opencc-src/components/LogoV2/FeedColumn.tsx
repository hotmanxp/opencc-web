// @ts-nocheck
import type { FeedConfig } from './Feed.js';
import { calculateFeedWidth } from './Feed.js'
type FeedColumnProps = {
  feeds: FeedConfig[];
  maxWidth: number;
};
export function FeedColumn(t0) {
  return null;
}
function _temp(feed) {
  return calculateFeedWidth(feed);
}
