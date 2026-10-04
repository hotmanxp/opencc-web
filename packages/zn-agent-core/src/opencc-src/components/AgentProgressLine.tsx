// @ts-nocheck
import type { Theme } from '../utils/theme.js';
type Props = {
  agentType: string;
  description?: string;
  name?: string;
  descriptionColor?: keyof Theme;
  taskDescription?: string;
  toolUseCount: number;
  tokens: number | null;
  color?: keyof Theme;
  isLast: boolean;
  isResolved: boolean;
  isError: boolean;
  isAsync?: boolean;
  shouldAnimate: boolean;
  lastToolInfo?: string | null;
  hideType?: boolean;
};
export function AgentProgressLine(t0: Props) {
  return null;
}
