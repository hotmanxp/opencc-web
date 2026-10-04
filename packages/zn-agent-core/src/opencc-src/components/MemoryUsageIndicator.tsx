import * as React from 'react';
export function MemoryUsageIndicator(): React.ReactNode | null {
  // Ant-only: the /heapdump link is an internal debugging aid. Gating before
  // the hook means the 10s polling interval is never set up in external builds.
  // USER_TYPE is a build-time constant, so the hook call below is either always
  // reached or dead-code-eliminated — never conditional at runtime.
  return null;
}
