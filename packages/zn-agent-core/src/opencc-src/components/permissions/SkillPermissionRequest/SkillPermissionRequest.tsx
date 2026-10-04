import { logError } from 'src/utils/log.js';
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js';
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
