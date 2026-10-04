// @ts-nocheck
import figures from 'figures';
import React, { useState } from 'react';
import TextInput from './TextInput.js';

type Props = {
  initialValueSec: string;
  onComplete: (valueSec: string) => void;
  onCancel: () => void;
};

export function AutoContinueTimeoutPicker(props: Props): React.ReactNode | null {
  return null;
}