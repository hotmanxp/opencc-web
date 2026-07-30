// CJS shim for opencc-src/ink/screen.js. The vendored opencc copy
// has a mismatch: ink/selection.ts and ink/ink.tsx import `CellWidth`
// from screen.js, but screen.js doesn't actually export it (the values
// are referenced as numeric literals in comments). This shim re-exports
// everything from the real screen.js and adds the missing `CellWidth`
// enum so the TUI code paths load without throwing.
//
// Used by bun-protocol.mjs to redirect `ink/screen.js` imports. Under
// Bun, screen.js is the one file opencc vendor references that breaks
// the chain — its internal references to `CellWidth.Narrow` etc. as
// JSDoc comments suggest the enum was once exported but is no longer.

const realScreen = require('../opencc-src/ink/screen.js')

realScreen.CellWidth = Object.freeze({
  Narrow: 0,
  Wide: 1,
  SpacerTail: 2,
})

module.exports = realScreen
