// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box } from '../../ink.js';
import { Divider } from '../design-system/Divider.js';
import type { FeedConfig } from './Feed.js';
import { calculateFeedWidth, Feed } from './Feed.js';
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
