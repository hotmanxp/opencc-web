import * as React from 'react';
import { PermissionRuleList } from '../../components/permissions/rules/PermissionRuleList.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { createPermissionRetryMessage } from '../../utils/messages.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return Promise.resolve(null);
};
