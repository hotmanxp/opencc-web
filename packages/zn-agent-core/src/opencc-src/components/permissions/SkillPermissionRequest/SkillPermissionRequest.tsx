// @ts-nocheck
import { logError } from 'src/utils/log.js';
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js';
type SkillOptionValue = 'yes' | 'yes-exact' | 'yes-prefix' | 'no';
export function SkillPermissionRequest(props) {
  return null;
}
function _temp(input) {
  const result = SkillTool.inputSchema.safeParse(input);
  if (!result.success) {
    logError(new Error(`Failed to parse skill tool input: ${result.error.message}`));
    return "";
  }
  return result.data.skill;
}
