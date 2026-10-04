// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import sample from 'lodash-es/sample.js';
import * as React from 'react';
import { useMemo } from 'react';
import { Box, Text } from '../../ink.js';
import { extractTag } from '../../utils/messages.js';
import { MessageResponse } from '../MessageResponse.js';
function getSavingMessage(): string {
  return sample(['Got it.', 'Good to know.', 'Noted.']);
}
type Props = {
  addMargin: boolean;
  text: string;
};
export function UserMemoryInputMessage(t0) {
  return null;
}
