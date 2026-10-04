// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import { getSlowOperations } from '../bootstrap/state.js';
import { Text, useInterval } from '../ink.js';
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
