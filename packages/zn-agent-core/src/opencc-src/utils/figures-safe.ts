/**
 * Safe figures wrapper that replaces problematic Unicode characters.
 *
 * The `figures` package uses ✔ (U+2714) and ✘ (U+2718) which have ambiguous
 * East-Asian width. In terminals with certain fonts/settings, these render as
 * double-width, causing ink's Dialog to leave ghost characters on re-render.
 *
 * This wrapper replaces them with ✓ (U+2713) and ✗ (U+2717) which have
 * consistent single-width rendering.
 */
import figures from 'figures';

const SAFE_FIGURES = {
  tick: '✓',
  cross: '✗',
};

export const safeFigures = {
  ...figures,
  tick: SAFE_FIGURES.tick,
  cross: SAFE_FIGURES.cross,
};

export default safeFigures;
