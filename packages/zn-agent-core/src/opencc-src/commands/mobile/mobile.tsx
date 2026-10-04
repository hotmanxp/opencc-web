// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pane } from '../../components/design-system/Pane.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
type Platform = 'ios' | 'android';
type Props = {
  onDone: () => void;
};
const PLATFORMS: Record<Platform, {
  url: string;
}> = {
  ios: {
    url: 'https://apps.apple.com/app/claude-by-anthropic/id6473753684'
  },
  android: {
    url: 'https://play.google.com/store/apps/details?id=com.anthropic.claude'
  }
};
function MobileQRCode(t0) {
  return null;
}
function _temp4(line_0, i) {
  return <Text key={i}>{line_0}</Text>;
}
function _temp3(line) {
  return line.length > 0;
}
function _temp2(prev) {
  return prev === "ios" ? "android" : "ios";
}
function _temp() {}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <MobileQRCode onDone={onDone} />;
}
