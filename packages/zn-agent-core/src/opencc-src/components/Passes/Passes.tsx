// @ts-nocheck
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import {  } from '../../constants/product.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to copy link
type PassStatus = {
  passNumber: number;
  isAvailable: boolean;
};
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function Passes({
  onDone
}: Props): React.ReactNode | null {
  return null;
}
