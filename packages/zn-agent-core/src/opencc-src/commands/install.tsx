// @ts-nocheck
import { homedir } from 'node:os';
import { join } from 'node:path';
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { Box, render, Text } from '../ink.js';
import { env } from '../utils/env.js';
interface InstallProps {
  onDone: (result: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  force?: boolean;
  target?: string; // 'latest', 'stable', or version like '1.0.34'
}
type InstallState = {
  type: 'checking';
} | {
  type: 'cleaning-npm';
} | {
  type: 'installing';
  version: string;
} | {
  type: 'setting-up';
} | {
  type: 'set-up';
  messages: string[];
} | {
  type: 'success';
  version: string;
  setupMessages?: string[];
  location?: string;
} | {
  type: 'error';
  message: string;
  warnings?: string[];
};
export function getInstallationPath(): string {
  const isWindows = env.platform === 'win32';
  const homeDir = homedir();
  if (isWindows) {
    // Convert to Windows-style path
    const windowsPath = join(homeDir, '.local', 'bin', 'opencc.exe');
    // Replace forward slashes with backslashes for Windows display
    return windowsPath.replace(/\//g, '\\');
  }
  return '~/.local/bin/opencc';
}
function SetupNotes(t0) {
  return null;
}
function _temp(message, index) {
  return <Box key={index} marginLeft={2}><Text dimColor={true}>• {message}</Text></Box>;
}
export function Install({
  onDone,
  force,
  target
}: InstallProps): React.ReactNode | null {
  return null;
}

// This is only used from cli.tsx, not as a slash command
export const install = {
  type: 'local-jsx' as const,
  name: 'install',
  description: '安装 Z.Ai 原生构建',
  argumentHint: '[options]',
  async call(onDone: (result: string, options?: {
    display?: CommandResultDisplay;
  }) => void, _context: unknown, args: string[]) {
    // Parse arguments
    const force = args.includes('--force');
    const nonFlagArgs = args.filter(arg => !arg.startsWith('--'));
    const target = nonFlagArgs[0]; // 'latest', 'stable', or version like '1.0.34'

    const {
      unmount
    } = await render(<Install onDone={(result, options) => {
      unmount();
      onDone(result, options);
    }} force={force} target={target} />);
  }
};
