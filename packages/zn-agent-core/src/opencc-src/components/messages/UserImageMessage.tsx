// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { pathToFileURL } from 'url';
import Link from '../../ink/components/Link.js';
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.js';
import { Box, Text } from '../../ink.js';
import { getStoredImagePath } from '../../utils/imageStore.js';
import { MessageResponse } from '../MessageResponse.js';
type Props = {
  imageId?: number;
  addMargin?: boolean;
};

/**
 * Renders an image attachment in user messages.
 * Shows as a clickable link if the image is stored and terminal supports hyperlinks.
 * Uses MessageResponse styling to appear connected to the message above,
 * unless addMargin is true (image starts a new user turn without text).
 */
export function UserImageMessage(t0) {
  return null;
}
