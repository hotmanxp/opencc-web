// @ts-nocheck
import chalk from 'chalk';
import type { CommandResultDisplay } from '../../../commands.js';
import type { PermissionBehavior, PermissionRule } from '../../../utils/permissions/PermissionRule.js'
import type { Option } from '../../ui/option.js';
type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace';
type RuleSourceTextProps = {
  rule: PermissionRule;
};
function RuleSourceText(t0) {
  return null;
}

// Helper function to get the appropriate label for rule behavior
function getRuleBehaviorLabel(ruleBehavior: PermissionBehavior): string {
  switch (ruleBehavior) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'denied';
    case 'ask':
      return 'ask';
  }
}

// Component for showing tool details and managing the interactive deletion workflow
function RuleDetails(t0) {
  return null;
}
type RulesTabContentProps = {
  options: Option[];
  searchQuery: string;
  isSearchMode: boolean;
  isFocused: boolean;
  onSelect: (value: string) => void;
  onCancel: () => void;
  lastFocusedRuleKey: string | undefined;
  cursorOffset?: number;
  onHeaderFocusChange?: (focused: boolean) => void;
};

// Component for rendering rules tab content with full width support
function RulesTabContent(props) {
  return null;
}

// Composes the subtitle + search + Select for a single allow/ask/deny tab.
function PermissionRulesTab(t0) {
  return null;
}
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
    shouldQuery?: boolean;
    metaMessages?: string[];
  }) => void;
  initialTab?: TabType;
  onRetryDenials?: (commands: string[]) => void;
};
export function PermissionRuleList(t0) {
  return null;
}
function _temp6(opt_0) {
  return opt_0.value;
}
function _temp5(opt) {
  return opt.value !== "add-new-rule";
}
function _temp4(d_1) {
  return chalk.bold(d_1.display);
}
function _temp3(d_0) {
  return d_0.display;
}
function _temp2(d) {
  return d !== undefined;
}
function _temp(s) {
  return s.toolPermissionContext;
}
