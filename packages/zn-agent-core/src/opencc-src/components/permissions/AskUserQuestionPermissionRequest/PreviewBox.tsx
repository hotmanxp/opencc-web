// @ts-nocheck
import { stringWidth } from '../../../ink/stringWidth.js';
import { type CliHighlight } from '../../../utils/cliHighlight.js'
import sliceAnsi from '../../../utils/sliceAnsi.js';
type PreviewBoxProps = {
  /** The preview content to display. Markdown is rendered with syntax highlighting
   * for code blocks (```ts, ```py, etc.). Also supports plain multi-line text. */
  content: string;
  /** Maximum number of lines to display before truncating. @default 20 */
  maxLines?: number;
  /** Minimum height (in lines) for the preview box. Content will be padded if shorter. */
  minHeight?: number;
  /** Minimum width for the preview box. @default 40 */
  minWidth?: number;
  /** Maximum width available for this box (e.g., the container width). */
  maxWidth?: number;
};
const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤'
};

/**
 * A bordered monospace box for displaying preview content.
 * Truncates content that exceeds maxLines with an indicator.
 * The parent component should pass maxLines based on its available height budget.
 */
export function PreviewBox(props: PreviewBoxProps) {
  return null;
}
function PreviewBoxWithHighlight(props: PreviewBoxProps) {
  return null;
}
function PreviewBoxBody(t0: PreviewBoxProps & { highlight: CliHighlight | null }) {
  return null;
}
function _temp(line: string) {
  return stringWidth(line);
}
