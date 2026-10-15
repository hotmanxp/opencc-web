import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
function MemoryCommand({
  onDone
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}): React.ReactNode | null {
  return null;
}
export const call: LocalJSXCommandCall = async onDone => {
  // Clear + prime before rendering — Suspense handles the unprimed case,
  // but awaiting here avoids a fallback flash on initial open.
  return Promise.resolve(null);
};
