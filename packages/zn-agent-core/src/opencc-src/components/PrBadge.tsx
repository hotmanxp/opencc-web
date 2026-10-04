// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { Link, Text } from '../ink.js';
import type { PrReviewState } from '../utils/ghPrStatus.js';
type Props = {
  number: number;
  url: string;
  reviewState?: PrReviewState;
  bold?: boolean;
};
export function PrBadge(t0: Props): React.ReactNode | null {
  return null;
}
function getPrStatusColor(state?: PrReviewState): 'success' | 'error' | 'warning' | 'merged' | undefined {
  switch (state) {
    case 'approved':
      return 'success';
    case 'changes_requested':
      return 'error';
    case 'pending':
      return 'warning';
    case 'merged':
      return 'merged';
    default:
      return undefined;
  }
}
