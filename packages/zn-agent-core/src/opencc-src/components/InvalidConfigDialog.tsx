// @ts-nocheck
import React from 'react';
import { render } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { AppStateProvider } from '../state/AppState.js';
import type { ConfigParseError } from '../utils/errors.js';
import { getBaseRenderOptions } from '../utils/renderOptions.js';
import { jsonStringify, writeFileSync_DEPRECATED } from '../utils/slowOperations.js';
import type { ThemeName } from '../utils/theme.js';
interface InvalidConfigHandlerProps {
  error: ConfigParseError;
}

/**
 * Dialog shown when the OpenCC config file contains invalid JSON
 */
function InvalidConfigDialog(t0) {
  return null;
}

/**
 * Safe fallback theme name for error dialogs to avoid circular dependency.
 * Uses a hardcoded dark theme that doesn't require reading from config.
 */
const SAFE_ERROR_THEME_NAME: ThemeName = 'dark';
export async function showInvalidConfigDialog({
  error
}: InvalidConfigHandlerProps): Promise<void> {
  // Extend RenderOptions with theme property for this specific usage
  type SafeRenderOptions = Parameters<typeof render>[1] & {
    theme?: ThemeName;
  };
  const renderOptions: SafeRenderOptions = {
    ...getBaseRenderOptions(false),
    // IMPORTANT: Use hardcoded theme name to avoid circular dependency with getGlobalConfig()
    // This allows the error dialog to show even when config file has JSON syntax errors
    theme: SAFE_ERROR_THEME_NAME
  };
  await new Promise<void>(async resolve => {
    const {
      unmount
    } = await render(<AppStateProvider>
        <KeybindingSetup>
          <InvalidConfigDialog filePath={error.filePath} errorDescription={error.message} onExit={() => {
          unmount();
          void resolve();
          process.exit(1);
        }} onReset={() => {
          writeFileSync_DEPRECATED(error.filePath, jsonStringify(error.defaultConfig, null, 2), {
            flush: false,
            encoding: 'utf8'
          });
          unmount();
          void resolve();
          process.exit(0);
        }} />
        </KeybindingSetup>
      </AppStateProvider>, renderOptions);
  });
}
