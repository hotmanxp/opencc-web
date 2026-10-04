// @ts-nocheck
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';
import { Suspense, useState } from 'react';
import { buildDiagnostics } from './Status.js'
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
