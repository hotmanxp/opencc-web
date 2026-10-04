// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { env } from '../../utils/env.js';
export type ClawdPose = 'default' | 'arms-up' // both arms raised (used during jump)
| 'look-left' // both pupils shifted left
| 'look-right'; // both pupils shifted right

type Props = {
  pose?: ClawdPose;
};

// Standard-terminal pose fragments. Each row is split into segments so we can
// vary only the parts that change (eyes, arms) while keeping the body/bg spans
// stable. All poses end up 9 cols wide.
//
// arms-up: the row-2 arm shapes (▝▜ / ▛▘) move to row 1 as their
// bottom-heavy mirrors (▗▟ / ▙▖) — same silhouette, one row higher.
//
// look-* use top-quadrant eye chars (▙/▟) so both eyes change from the
// default (▛/▜, bottom pupils) — otherwise only one eye would appear to move.
type Segments = {
  /** row 1 left (no bg): optional raised arm + side */
  r1L: string;
  /** row 1 eyes (with bg): left-eye, forehead, right-eye */
  r1E: string;
  /** row 1 right (no bg): side + optional raised arm */
  r1R: string;
  /** row 2 left (no bg): arm + body curve */
  r2L: string;
  /** row 2 right (no bg): body curve + arm */
  r2R: string;
};
const POSES: Record<ClawdPose, Segments> = {
  default: {
    r1L: ' ╭',
    r1E: '◌ ◌ ',
    r1R: '╮',
    r2L: ' ┆',
    r2R: '┆ '
  },
  'look-left': {
    r1L: ' ╭',
    r1E: '◔ ◌ ',
    r1R: '╮',
    r2L: ' ┆',
    r2R: '┆ '
  },
  'look-right': {
    r1L: ' ╭',
    r1E: '◌ ◔ ',
    r1R: '╮',
    r2L: ' ┆',
    r2R: '┆ '
  },
  'arms-up': {
    r1L: '\\╭',
    r1E: '◌ ◌ ',
    r1R: '╮/',
    r2L: ' ┆',
    r2R: '┆ '
  }
};

// Apple Terminal uses a bg-fill trick (see below), so only eye poses make
// sense. Arm poses fall back to default.
const APPLE_EYES: Record<ClawdPose, string> = {
  default: ' ◌ ◌  ',
  'look-left': ' ◔ ◌  ',
  'look-right': ' ◌ ◔  ',
  'arms-up': ' ◌ ◌  '
};
export function Clawd(t0) {
  return null;
}
function AppleTerminalClawd(t0) {
  return null;
}
