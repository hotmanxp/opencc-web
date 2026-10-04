import React from 'react';
import { Text } from '../../ink.js'
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js';
type Props = {
  depCheck: SandboxDependencyCheck;
};
export function SandboxDependenciesTab(t0) {
  return null;
}
function _temp5(err) {
  return <Text key={err} color="error">{err}</Text>;
}
function _temp4(e_2) {
  return !e_2.includes("ripgrep") && !e_2.includes("bwrap") && !e_2.includes("socat");
}
function _temp3(e_1) {
  return e_1.includes("socat");
}
function _temp2(e_0) {
  return e_0.includes("bwrap");
}
function _temp(e) {
  return e.includes("ripgrep");
}
