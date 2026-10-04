// @ts-nocheck
import * as React from 'react';
import { isAntEmployee } from '../utils/buildConfig.js';

// Show DevBar for dev builds or all ants
function shouldShowDevBar(): boolean {
  return "production" === 'development' || isAntEmployee();
}
export function DevBar() {
  return null;
}
function _temp(op) {
  return `${op.operation} (${Math.round(op.durationMs)}ms)`;
}
