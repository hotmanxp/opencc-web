// @ts-nocheck
import * as React from 'react';
import { type NetworkHostPattern } from 'src/utils/sandbox/sandbox-adapter.js'
export type SandboxPermissionRequestProps = {
  hostPattern: NetworkHostPattern;
  onUserResponse: (response: {
    allow: boolean;
    persistToSettings: boolean;
  }) => void;
};
export function SandboxPermissionRequest(t0) {
  return null;
}
