// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
/**
 * ViewHookMode shows read-only details for a single configured hook.
 *
 * The /hooks menu is read-only; this view replaces the former delete-hook
 * confirmation screen and directs users to settings.json or OpenCC for edits.
 */
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { hookSourceDescriptionDisplayString, type IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { Dialog } from '../design-system/Dialog.js';
type Props = {
  selectedHook: IndividualHookConfig;
  eventSupportsMatcher: boolean;
  onCancel: () => void;
};
export function ViewHookMode(t0) {
  return null;
}

/**
 * Get a human-readable label for the primary content field of a hook
 * based on its type.
 */
function _temp() {
  return <Text>Esc to go back</Text>;
}
function getContentFieldLabel(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return 'Command';
    case 'prompt':
      return 'Prompt';
    case 'agent':
      return 'Prompt';
    case 'http':
      return 'URL';
  }
}

/**
 * Get the actual content value for a hook's primary field, bypassing
 * statusMessage so the detail view always shows the real command/prompt/URL.
 */
function getContentFieldValue(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return config.command;
    case 'prompt':
      return config.prompt;
    case 'agent':
      return config.prompt;
    case 'http':
      return config.url;
  }
}
