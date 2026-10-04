// @ts-nocheck
import React from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { Box, Text } from '../../ink.js';
import type { DreamTaskState } from '../../tasks/DreamTask/DreamTask.js';
import { plural } from '../../utils/stringUtils.js';
type Props = {
  task: DeepImmutable<DreamTaskState>;
  onDone: () => void;
  onBack?: () => void;
  onKill?: () => void;
};

// How many recent turns to render. Earlier turns collapse to a count.
const VISIBLE_TURNS = 6;
export function DreamDetailDialog(t0) {
  return null;
}
function _temp2(turn, i) {
  return <Box key={i} flexDirection="column"><Text wrap="wrap">{turn.text}</Text>{turn.toolUseCount > 0 && <Text dimColor={true}>{"  "}({turn.toolUseCount}{" "}{plural(turn.toolUseCount, "tool")})</Text>}</Box>;
}
function _temp(t) {
  return t.text !== "";
}
