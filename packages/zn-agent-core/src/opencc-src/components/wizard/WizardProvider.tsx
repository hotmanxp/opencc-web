// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { createContext, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import type { WizardContextValue, WizardProviderProps } from './types.js';

// Use any here for the context since it will be cast properly when used
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WizardContext = createContext<WizardContextValue<any> | null>(null);
export function WizardProvider<T extends Record<string, unknown> = Record<string, unknown>>(t0: WizardProviderProps<T>): React.ReactNode | null {
  return null;
}
function _temp3(prev_2) {
  return prev_2 - 1;
}
function _temp2(prev_1) {
  return prev_1.slice(0, -1);
}
function _temp(prev_0) {
  return prev_0 + 1;
}
