// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useContext } from 'react';
import { Box, NoSelect, Text } from '../ink.js';
import { Ratchet } from './design-system/Ratchet.js';
type Props = {
  children: React.ReactNode;
  height?: number;
};
export function MessageResponse(t0) {
  return null;
}

// This is a context that is used to determine if the message response
// is rendered as a descendant of another MessageResponse. We use it
// to avoid rendering nested └ characters.
const MessageResponseContext = React.createContext(false);
function MessageResponseProvider(t0) {
  return null;
}
