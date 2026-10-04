import * as React from 'react';
import { HooksConfigMenu } from '../../components/hooks/HooksConfigMenu.js';
import { logEvent } from '../../services/analytics/index.js';
import { getTools } from '../../tools.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return Promise.resolve(null);
};
