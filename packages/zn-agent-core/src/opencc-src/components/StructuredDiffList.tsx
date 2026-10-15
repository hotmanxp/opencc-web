import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
type Props = {
  hunks: StructuredPatchHunk[];
  dim: boolean;
  width: number;
  filePath: string;
  firstLine: string | null;
  fileContent?: string;
};

/** Renders a list of diff hunks with ellipsis separators between them. */
export function StructuredDiffList({
  hunks,
  dim,
  width,
  filePath,
  firstLine,
  fileContent
}: Props): React.ReactNode | null {
  return null;
}
