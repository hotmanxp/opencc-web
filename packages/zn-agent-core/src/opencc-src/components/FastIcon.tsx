// @ts-nocheck
import chalk from 'chalk';
import { LIGHTNING_BOLT } from '../constants/figures.js';
import { getGlobalConfig } from '../utils/config.js';
import { resolveThemeSetting } from '../utils/systemTheme.js';
import { color } from './design-system/color.js';
type Props = {
  cooldown?: boolean;
};
export function FastIcon(t0: Props) {
  return null;
}
export function getFastIconString(applyColor = true, cooldown = false): string {
  if (!applyColor) {
    return LIGHTNING_BOLT;
  }
  const themeName = resolveThemeSetting(getGlobalConfig().theme);
  if (cooldown) {
    return chalk.dim(color('promptBorder', themeName)(LIGHTNING_BOLT));
  }
  return color('fastMode', themeName)(LIGHTNING_BOLT);
}
