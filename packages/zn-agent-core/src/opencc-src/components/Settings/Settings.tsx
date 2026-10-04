// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';
import { Suspense, useState } from 'react';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js';
import { Pane } from '../design-system/Pane.js';
import { Tabs, Tab, useTabHeaderFocus } from '../design-system/Tabs.js';
import { Status, buildDiagnostics } from './Status.js';
import { Config } from './Config.js';
import { Usage } from './Usage.js';
import { Stats } from '../Stats.js';
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js';
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  context: LocalJSXCommandContext;
  defaultTab: 'Status' | 'Config' | 'Usage' | 'Gates' | 'Stats';
};
// Only Stats needs the dynamic blur — it's the only tab that nests a
// second <Tabs> (Overview/Models) that also registers
// tabs:next/tabs:previous with context="Tabs". Config/Gates use
// useTabHeaderFocus instead (down-arrow blurs header, no nested Tabs
// competing for the same keybinding), so they MUST stay in the outer
// focus path — otherwise the user couldn't right-arrow from Config to
// Usage after entering Config.
const STATIC_FOCUS_BLUR_TAB_IDS = ['Stats'];
export function Settings(t0) {
  return null;
}
function _temp2() {
  return buildDiagnostics().catch(_temp);
}
function _temp() {
  return [];
}
