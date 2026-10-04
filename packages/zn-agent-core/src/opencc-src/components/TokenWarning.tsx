// @ts-nocheck
type Props = {
  tokenUsage: number;
  model: string;
};

/**
 * Live collapse progress: "x / y summarized". Sub-component so
 * useSyncExternalStore can subscribe to store mutations unconditionally
 * (hooks-in-conditionals would violate React rules). The parent only
 * renders this when feature('CONTEXT_COLLAPSE') + isContextCollapseEnabled().
 */
function CollapseLabel(t0) {
  return null;
}
export function TokenWarning(t0) {
  return null;
}
