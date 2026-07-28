/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events'

/**
 * A shared event emitter for application-wide communication
 * between decoupled parts of the CLI for update events.
 */
export const updateEventEmitter = new EventEmitter()

export const UPDATE_EVENTS = {
  UPDATE_RECEIVED: 'update-received',
  UPDATE_SUCCESS: 'update-success',
  UPDATE_FAILED: 'update-failed',
  UPDATE_INFO: 'update-info',
} as const
