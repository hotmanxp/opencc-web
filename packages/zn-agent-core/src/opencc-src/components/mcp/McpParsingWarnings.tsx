// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useMemo } from 'react';
import { getMcpConfigsByScope } from 'src/services/mcp/config.js';
import type { ConfigScope } from 'src/services/mcp/types.js';
import { describeMcpConfigFilePath, getScopeLabel } from 'src/services/mcp/utils.js';
import type { ValidationError } from 'src/utils/settings/validation.js';
import { Box, Link, Text } from '../../ink.js';
function McpConfigErrorSection(t0) {
  return null;
}
function _temp2(warning, i_0) {
  const serverName_0 = warning.mcpErrorMetadata?.serverName;
  return <Box key={`warning-${i_0}`}><Text><Text dimColor={true}>└ </Text><Text color="warning">[Warning]</Text><Text dimColor={true}>{" "}{serverName_0 && `[${serverName_0}] `}{warning.path && warning.path !== "" ? `${warning.path}: ` : ""}{warning.message}</Text></Text></Box>;
}
function _temp(error, i) {
  const serverName = error.mcpErrorMetadata?.serverName;
  return <Box key={`error-${i}`}><Text><Text dimColor={true}>└ </Text><Text color="error">[Error]</Text><Text dimColor={true}>{" "}{serverName && `[${serverName}] `}{error.path && error.path !== "" ? `${error.path}: ` : ""}{error.message}</Text></Text></Box>;
}
export function McpParsingWarnings() {
  return null;
}
function _temp5(t0) {
  const {
    scope,
    config: config_1
  } = t0;
  return <McpConfigErrorSection key={scope} scope={scope} parsingErrors={filterErrors(config_1.errors, "fatal")} warnings={filterErrors(config_1.errors, "warning")} />;
}
function _temp4(t0) {
  const {
    config: config_0
  } = t0;
  return filterErrors(config_0.errors, "warning").length > 0;
}
function _temp3(t0) {
  const {
    config
  } = t0;
  return filterErrors(config.errors, "fatal").length > 0;
}
function filterErrors(errors: ValidationError[], severity: 'fatal' | 'warning'): ValidationError[] {
  return errors.filter(e => e.mcpErrorMetadata?.severity === severity);
}
