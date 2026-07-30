// @ts-nocheck
import figures from 'figures';
import React, { useState } from 'react';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import TextInput from './TextInput.js';

type Props = {
  initialValueSec: string;
  onComplete: (valueSec: string) => void;
  onCancel: () => void;
};

export function AutoContinueTimeoutPicker(props: Props): React.ReactNode {
  const { initialValueSec, onComplete, onCancel } = props;
  const [value, setValue] = useState(initialValueSec);
  const [cursorOffset, setCursorOffset] = useState(initialValueSec.length);

  useKeybinding(
    'confirm:no',
    onCancel,
    { context: 'Settings' },
  );

  const handleSubmit = (): void => {
    const trimmed = value.trim();
    if (trimmed === '') {
      onComplete('0');
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      onComplete('0');
      return;
    }
    onComplete(String(n));
  };

  return (
    <Box flexDirection="column">
      <Text>
        Seconds before an unanswered AskUserQuestion dialog auto-submits with default answers. Set to 0 to disable.
      </Text>
      <Box marginTop={1}>
        <Text>{figures.pointer}</Text>{' '}
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          focus={true}
          showCursor={true}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          placeholder="0"
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Examples: 0 (disabled), 30, 60, 120, 300.</Text>
      </Box>
    </Box>
  );
}