import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { FORK_DIRECTIVE_PREFIX } from '../../constants/xml.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

// A fork-boilerplate user message carries the verbose forked-worker instruction
// block (buildChildMessage in forkSubagent.ts) followed by `Your directive: …`.
// Dumping the whole rules block into the transcript is noise; render a compact
// marker with just the directive.
export function UserForkBoilerplateMessage({ addMargin, param }: Props) {
  return null;
}
