// @ts-nocheck
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js';
import { logForDebugging } from '../../utils/debug.js';
type Props = {
  onDone: () => void;
};
function SessionInfo(t0) {
  return null;
}
function _temp4(line_0, i) {
  return <Text key={i}>{line_0}</Text>;
}
function _temp3(line) {
  return line.length > 0;
}
function _temp2(e) {
  logForDebugging("QR code generation failed", e);
}
function _temp(s) {
  return s.remoteSessionUrl;
}
export const call: LocalJSXCommandCall = async onDone => {
  return Promise.resolve(null);
};
