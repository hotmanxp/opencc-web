// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { stringWidth } from '../../ink/stringWidth.js';
type TabsContextValue = {
  selectedTab: string | undefined;
  width: number | undefined;
  headerFocused: boolean;
  focusHeader: () => void;
  blurHeader: () => void;
  registerOptIn: () => () => void;
};
const TabsContext = createContext<TabsContextValue>({
  selectedTab: undefined,
  width: undefined,
  // Default for components rendered outside a Tabs (tests, standalone):
  // content has focus, focusHeader is a no-op.
  headerFocused: false,
  focusHeader: () => {},
  blurHeader: () => {},
  registerOptIn: () => () => {}
});

// Context to pass outer tabs focus functions to Stats component
const OuterTabsFocusContext = createContext<{ focusHeader: () => void; blurHeader: () => void } | null>(null);
export function useOuterTabsFocus() {
  return useContext(OuterTabsFocusContext);
}
export function Tabs(t0) {
  return null;
}
function _temp4(sum, t0) {
  const [, tabTitle] = t0;
  return sum + (tabTitle ? stringWidth(tabTitle) : 0) + 2 + 1;
}
function _temp3(n_0) {
  return n_0 - 1;
}
function _temp2(n) {
  return n + 1;
}
function _temp(child) {
  return [child.props.id ?? child.props.title, child.props.title];
}
export function Tab(t0) {
  return null;
}
export function useTabsWidth() {
  const {
    width
  } = useContext(TabsContext);
  return width;
}

/**
 * Opt into header-focus gating. Returns the current header focus state and a
 * callback to hand focus back to the tab row. For a Select, pass
 * `isDisabled={headerFocused}` and `onUpFromFirstItem={focusHeader}`; keep the
 * parent Tabs' initialHeaderFocused at its default so tab/←/→ work on mount.
 *
 * Calling this hook registers a ↓-blurs-header opt-in on mount. Don't call it
 * above an early return that renders static text — ↓ will blur the header with
 * no onUpFromFirstItem to recover. Split the component so the hook only runs
 * when the Select renders.
 */
export function useTabHeaderFocus() {
  const $ = _c(6);
  const {
    headerFocused,
    focusHeader,
    blurHeader,
    registerOptIn
  } = useContext(TabsContext);
  let t0;
  if ($[0] !== registerOptIn) {
    t0 = [registerOptIn];
    $[0] = registerOptIn;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  useEffect(registerOptIn, t0);
  let t1;
  if ($[2] !== blurHeader || $[3] !== focusHeader || $[4] !== headerFocused) {
    t1 = {
      headerFocused,
      focusHeader,
      blurHeader
    };
    $[2] = blurHeader;
    $[3] = focusHeader;
    $[4] = headerFocused;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  return t1;
}
