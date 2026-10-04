// @ts-nocheck
import type { ElicitResult, PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js'
import figures from '../../utils/figures-safe.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw text input for elicitation form
import type { ElicitationRequestEvent } from '../../services/mcp/elicitationHandler.js';
import TextInput from '../TextInput.js';
type Props = {
  event: ElicitationRequestEvent;
  onResponse: (action: ElicitResult['action'], content?: ElicitResult['content']) => void;
  /** Called when the phase 2 waiting state is dismissed (URL elicitations only). */
  onWaitingDismiss?: (action: 'dismiss' | 'retry' | 'cancel') => void;
};
const isTextField = (s: PrimitiveSchemaDefinition) => ['string', 'number', 'integer'].includes(s.type);
const RESOLVING_SPINNER_CHARS = '\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F';
const advanceSpinnerFrame = (f: number) => (f + 1) % RESOLVING_SPINNER_CHARS.length;

/** Timer callback for enumTypeaheadRef — module-scope to avoid closure capture. */
function resetTypeahead(ta: {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}): void {
  ta.buffer = '';
  ta.timer = undefined;
}

/**
 * Isolated spinner glyph for a field that is being resolved asynchronously.
 * Owns its own 80ms animation timer so ticks only re-render this tiny leaf,
 * not the entire ElicitationFormDialog (~1200 lines + renderFormFields).
 * Mounted/unmounted by the parent via the `isResolving` condition.
 *
 * Not using the shared <Spinner /> from ../Spinner.js: that one renders in a
 * <Box width={2}> with color="text", which would break the 1-col checkbox
 * column alignment here (other checkbox states are width-1 glyphs).
 */
function ResolvingSpinner() {
  return null;
}

/** Format an ISO date/datetime for display, keeping the ISO value for submission. */
function formatDateDisplay(isoValue: string, schema: PrimitiveSchemaDefinition): string {
  try {
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) return isoValue;
    const format = 'format' in schema ? schema.format : undefined;
    if (format === 'date-time') {
      return date.toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      });
    }
    // date-only: parse as local date to avoid timezone shift
    const parts = isoValue.split('-');
    if (parts.length === 3) {
      const local = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      return local.toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    }
    return isoValue;
  } catch {
    return isoValue;
  }
}
export function ElicitationDialog(t0) {
  return null;
}
function ElicitationFormDialog({
  event,
  onResponse
}: {
  event: ElicitationRequestEvent;
  onResponse: Props['onResponse'];
}): React.ReactNode | null {
  return null;
}
function ElicitationURLDialog({
  event,
  onResponse,
  onWaitingDismiss
}: {
  event: ElicitationRequestEvent;
  onResponse: Props['onResponse'];
  onWaitingDismiss: Props['onWaitingDismiss'];
}): React.ReactNode | null {
  return null;
}
