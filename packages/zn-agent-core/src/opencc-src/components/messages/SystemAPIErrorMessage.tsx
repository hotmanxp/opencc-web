// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import { Box, Text } from 'src/ink.js';
import { briefAPIErrorReason, formatAPIError } from 'src/services/api/errorUtils.js';
import type { SystemAPIErrorMessage } from 'src/types/message.js';
import { useInterval } from 'usehooks-ts';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { MessageResponse } from '../MessageResponse.js';
const MAX_API_ERROR_CHARS = 1000;
type Props = {
  message: SystemAPIErrorMessage;
  verbose: boolean;
};
export function SystemAPIErrorMessage(t0) {
  return null;
}
function _temp(ms) {
  return ms + 1000;
}
