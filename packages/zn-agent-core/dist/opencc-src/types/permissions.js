const EXTERNAL_PERMISSION_MODES = [
  "acceptEdits",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan"
];
const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  ...true ? ["auto"] : []
];
const PERMISSION_MODES = INTERNAL_PERMISSION_MODES;
export {
  EXTERNAL_PERMISSION_MODES,
  INTERNAL_PERMISSION_MODES,
  PERMISSION_MODES
};
