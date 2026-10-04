// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { Suspense, use, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index.js';
import type { Message } from '../../types/message.js';
import { generatePermissionExplanation, isPermissionExplainerEnabled, type PermissionExplanation as PermissionExplanationType, type RiskLevel } from '../../utils/permissions/permissionExplainer.js';
import { ShimmerChar } from '../Spinner/ShimmerChar.js';
import { useShimmerAnimation } from '../Spinner/useShimmerAnimation.js';
const LOADING_MESSAGE = 'Loading explanation…';
function ShimmerLoadingText() {
  return null;
}
function getRiskColor(riskLevel: RiskLevel): 'success' | 'warning' | 'error' {
  switch (riskLevel) {
    case 'LOW':
      return 'success';
    case 'MEDIUM':
      return 'warning';
    case 'HIGH':
      return 'error';
  }
}
function getRiskLabel(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case 'LOW':
      return 'Low risk';
    case 'MEDIUM':
      return 'Med risk';
    case 'HIGH':
      return 'High risk';
  }
}
type PermissionExplanationProps = {
  toolName: string;
  toolInput: unknown;
  toolDescription?: string;
  messages?: Message[];
};
type ExplainerState = {
  visible: boolean;
  enabled: boolean;
  promise: Promise<PermissionExplanationType | null> | null;
};

/**
 * Creates an explanation promise that never rejects.
 * Errors are caught and returned as null.
 */
function createExplanationPromise(props: PermissionExplanationProps): Promise<PermissionExplanationType | null> {
  return generatePermissionExplanation({
    toolName: props.toolName,
    toolInput: props.toolInput,
    toolDescription: props.toolDescription,
    messages: props.messages,
    signal: new AbortController().signal // Won't abort - request is fast enough
  }).catch(() => null);
}

/**
 * Hook that manages the permission explainer state.
 * Creates the fetch promise lazily (only when user hits Ctrl+E)
 * to avoid consuming tokens for explanations users never view.
 */
export function usePermissionExplainerUI(props) {
  const $ = _c(9);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = isPermissionExplainerEnabled();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const enabled = t0;
  const [visible, setVisible] = useState(false);
  const [promise, setPromise] = useState(null);
  let t1;
  if ($[1] !== promise || $[2] !== props || $[3] !== visible) {
    t1 = () => {
      if (!visible) {
        logEvent("tengu_permission_explainer_shortcut_used", {});
        if (!promise) {
          setPromise(createExplanationPromise(props));
        }
      }
      setVisible(_temp);
    };
    $[1] = promise;
    $[2] = props;
    $[3] = visible;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Confirmation",
      isActive: enabled
    };
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  useKeybinding("confirm:toggleExplanation", t1, t2);
  let t3;
  if ($[6] !== promise || $[7] !== visible) {
    t3 = {
      visible,
      enabled,
      promise
    };
    $[6] = promise;
    $[7] = visible;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  return t3;
}

/**
 * Inner component that uses React 19's use() to read the promise.
 * Suspends while loading, returns null on error.
 */
function _temp(v) {
  return !v;
}
function ExplanationResult(t0) {
  return null;
}

/**
 * Content component - shows loading (via Suspense) or explanation when visible
 */
export function PermissionExplainerContent(t0) {
  return null;
}
