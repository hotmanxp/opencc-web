// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import figures from 'figures';
import Fuse from 'fuse.js';
import React from 'react';
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { applyColor } from '../ink/colorize.js';
import type { Color } from '../ink/styles.js';
import { Box, Text, useInput, useTerminalFocus, useTheme } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { logEvent } from '../services/analytics/index.js';
import type { LogOption, SerializedMessage } from '../types/logs.js';
import { formatLogMetadata, truncateToWidth } from '../utils/format.js';
import { getWorktreePaths } from '../utils/getWorktreePaths.js';
import { getBranch } from '../utils/git.js';
import { getLogDisplayTitle } from '../utils/log.js';
import { getFirstMeaningfulUserMessageTextContent, getSessionIdFromLog, isCustomTitleEnabled, saveCustomTitle } from '../utils/sessionStorage.js';
import { getTheme } from '../utils/theme.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select, type OptionWithDescription } from './CustomSelect/select.js';
import { Byline } from './design-system/Byline.js';
import { Divider } from './design-system/Divider.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { SearchBox } from './SearchBox.js';
import { SessionPreview } from './SessionPreview.js';
import { Spinner } from './Spinner.js';
import { TagTabs } from './TagTabs.js';
import TextInput from './TextInput.js';
import { type TreeNode, TreeSelect } from './ui/TreeSelect.js';
type AgenticSearchState = {
  status: 'idle';
} | {
  status: 'searching';
} | {
  status: 'results';
  results: LogOption[];
  query: string;
} | {
  status: 'error';
  message: string;
};
export type LogSelectorProps = {
  logs: LogOption[];
  maxHeight?: number;
  forceWidth?: number;
  onCancel?: () => void;
  onSelect: (log: LogOption) => void;
  onLogsChanged?: () => void;
  onLoadMore?: (count: number) => void;
  initialSearchQuery?: string;
  showAllProjects?: boolean;
  onToggleAllProjects?: () => void;
  onAgenticSearch?: (query: string, logs: LogOption[], signal?: AbortSignal) => Promise<LogOption[]>;
};
type LogTreeNode = TreeNode<{
  log: LogOption;
  indexInFiltered: number;
}>;
export type ResumeLogGroup = {
  id: string;
  headerLog: LogOption;
  childLogs: LogOption[];
  logs: LogOption[];
  firstIndex: number;
};
type ViewMode = 'list' | 'preview' | 'rename' | 'search';
type DeepSearchResult = {
  log: LogOption;
  score?: number;
  searchableText: string;
};
type DeepSearchResults = {
  results: DeepSearchResult[];
  query: string;
};
type FilteredLogState = {
  filteredLogs: LogOption[];
  snippets: Map<LogOption, Snippet>;
};
const EMPTY_AGENTIC_RESULTS: LogOption[] = [];
function normalizeAndTruncateToWidth(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return truncateToWidth(normalized, maxWidth);
}

// Width of prefixes that TreeSelect will add
const PARENT_PREFIX_WIDTH = 2; // '▼ ' or '▶ '
const CHILD_PREFIX_WIDTH = 4; // '  ▸ '

// Deep search constants
const DEEP_SEARCH_MAX_MESSAGES = 2000;
const DEEP_SEARCH_CROP_SIZE = 1000;
const DEEP_SEARCH_MAX_TEXT_LENGTH = 50000; // Cap searchable text per session
const FUSE_THRESHOLD = 0.3;
const DATE_TIE_THRESHOLD_MS = 60 * 1000; // 1 minute - use relevance as tie-breaker within this window
const SNIPPET_CONTEXT_CHARS = 50; // Characters to show before/after match

type Snippet = {
  before: string;
  match: string;
  after: string;
};
function formatSnippet({
  before,
  match,
  after
}: Snippet, highlightColor: (text: string) => string): string {
  return chalk.dim(before) + highlightColor(match) + chalk.dim(after);
}
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Search failed';
}
function extractSnippet(text: string, query: string, contextChars: number): Snippet | null {
  // Find exact query occurrence (case-insensitive).
  // Note: Fuse does fuzzy matching, so this may miss some fuzzy matches.
  // This is acceptable for now - in the future we could use Fuse's includeMatches
  // option and work with the match indices directly.
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex === -1) return null;
  const matchEnd = matchIndex + query.length;
  const snippetStart = Math.max(0, matchIndex - contextChars);
  const snippetEnd = Math.min(text.length, matchEnd + contextChars);
  const beforeRaw = text.slice(snippetStart, matchIndex);
  const matchText = text.slice(matchIndex, matchEnd);
  const afterRaw = text.slice(matchEnd, snippetEnd);
  return {
    before: (snippetStart > 0 ? '…' : '') + beforeRaw.replace(/\s+/g, ' ').trimStart(),
    match: matchText.trim(),
    after: afterRaw.replace(/\s+/g, ' ').trimEnd() + (snippetEnd < text.length ? '…' : '')
  };
}
function buildLogLabel(log: LogOption, maxLabelWidth: number, options?: {
  isGroupHeader?: boolean;
  isChild?: boolean;
  forkCount?: number;
}): string {
  const {
    isGroupHeader = false,
    isChild = false,
    forkCount = 0
  } = options || {};

  // TreeSelect will add the prefix, so we just need to account for its width
  const prefixWidth = isGroupHeader && forkCount > 0 ? PARENT_PREFIX_WIDTH : isChild ? CHILD_PREFIX_WIDTH : 0;
  const sessionCountSuffix = isGroupHeader && forkCount > 0 ? ` (+${forkCount} other ${forkCount === 1 ? 'session' : 'sessions'})` : '';
  const sidechainSuffix = log.isSidechain ? ' (sidechain)' : '';
  const maxSummaryWidth = maxLabelWidth - prefixWidth - sidechainSuffix.length - sessionCountSuffix.length;
  const truncatedSummary = normalizeAndTruncateToWidth(getResumeLogDisplayTitle(log), maxSummaryWidth);
  return `${truncatedSummary}${sidechainSuffix}${sessionCountSuffix}`;
}
function buildLogMetadata(log: LogOption, options?: {
  isChild?: boolean;
  showProjectPath?: boolean;
}): string {
  const {
    isChild = false,
    showProjectPath = false
  } = options || {};
  // Match the child prefix width for proper alignment
  const childPadding = isChild ? '    ' : ''; // 4 spaces to match '  ▸ '
  const baseMetadata = formatLogMetadata(log);
  const projectSuffix = showProjectPath && log.projectPath ? ` · ${log.projectPath}` : '';
  return childPadding + baseMetadata + projectSuffix;
}
export function getResumeLogDisplayTitle(log: LogOption): string {
  const branchName = log.sessionBranch?.branchName?.trim()
  if (branchName) {
    const sessionTitle = log.agentName || log.customTitle
    if (sessionTitle) return getLogDisplayTitle(log)
    return branchName
  }
  return getLogDisplayTitle(log)
}
export function logMatchesResumePickerSearch(log: LogOption, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return true
  const displayedTitle = getResumeLogDisplayTitle(log).toLowerCase()
  const baseDisplayTitle = getLogDisplayTitle(log).toLowerCase()
  const branchName = (log.sessionBranch?.branchName || "").toLowerCase()
  const branch = (log.gitBranch || "").toLowerCase()
  const tag = (log.tag || "").toLowerCase()
  const prInfo = log.prNumber ? `pr #${log.prNumber} ${log.prRepository || ""}`.toLowerCase() : ""
  return displayedTitle.includes(query) || baseDisplayTitle.includes(query) || branchName.includes(query) || branch.includes(query) || tag.includes(query) || prInfo.includes(query)
}
export function shouldLoadMoreResumeLogs(options: {
  displayedLogCount: number;
  focusedIndex: number;
  visibleCount: number;
  visibleNodeCount: number;
}): boolean {
  const {
    displayedLogCount,
    focusedIndex,
    visibleCount,
    visibleNodeCount
  } = options
  const buffer = visibleCount * 2
  return visibleNodeCount < visibleCount || focusedIndex + buffer >= displayedLogCount
}
export function countVisibleResumeTreeRows(
  nodes: readonly TreeNode<unknown>[],
  options: {
    expandedGroupSessionIds: ReadonlySet<string>;
    forceExpanded: boolean;
  },
): number {
  const { expandedGroupSessionIds, forceExpanded } = options
  const isExpanded = (nodeId: string | number): boolean => {
    if (forceExpanded) return true
    const groupSessionId = typeof nodeId === "string" && nodeId.startsWith("group:") ? nodeId.slice(6) : null
    return groupSessionId ? expandedGroupSessionIds.has(groupSessionId) : false
  }
  const countNode = (node: TreeNode<unknown>): number => {
    const children = node.children ?? []
    if (children.length === 0 || !isExpanded(node.id)) return 1
    return 1 + children.reduce((count, child) => count + countNode(child), 0)
  }

  return nodes.reduce((count, node) => count + countNode(node), 0)
}
function findContainingGroupNode(nodes: LogTreeNode[], nodeId?: string | number): LogTreeNode | null {
  if (!nodeId) return null
  for (const node of nodes) {
    if (node.id === nodeId) return node
    if (node.children?.some(child => child.id === nodeId)) {
      return node
    }
  }
  return null
}
export function LogSelector(t0: LogSelectorProps) {
  return null;
}

/**
 * Extracts searchable text content from a message.
 * Handles both string content and structured content blocks.
 */
function _temp7(r_0: DeepSearchResult): LogOption {
  return r_0.log;
}
function _temp6(log_6: LogOption): string | undefined {
  return log_6.messages[0]?.uuid;
}
function _temp5(fuseIndex_0, debouncedDeepSearchQuery_0, setDeepSearchResults_0, setIsSearching_0) {
  const results = fuseIndex_0.search(debouncedDeepSearchQuery_0);
  results.sort(_temp3);
  setDeepSearchResults_0({
    results: results.map(_temp4),
    query: debouncedDeepSearchQuery_0
  });
  setIsSearching_0(false);
}
function _temp4(r) {
  return {
    log: r.item.log,
    score: r.score,
    searchableText: r.item.searchableText
  };
}
function _temp3(a, b) {
  const aTime = new Date(a.item.log.modified).getTime();
  const bTime = new Date(b.item.log.modified).getTime();
  const timeDiff = bTime - aTime;
  if (Math.abs(timeDiff) > DATE_TIE_THRESHOLD_MS) {
    return timeDiff;
  }
  return (a.score ?? 1) - (b.score ?? 1);
}
function _temp2(log_1: LogOption): boolean {
  const currentSessionId = getSessionId();
  const logSessionId = getSessionIdFromLog(log_1);
  const isCurrentSession = currentSessionId && logSessionId === currentSessionId;
  if (isCurrentSession) {
    return true;
  }
  if (log_1.customTitle) {
    return true;
  }
  if (log_1.sessionBranch?.branchName?.trim()) {
    return true;
  }
  const fromMessages = getFirstMeaningfulUserMessageTextContent(log_1.messages);
  if (fromMessages) {
    return true;
  }
  if (log_1.firstPrompt || log_1.customTitle) {
    return true;
  }
  return false;
}
function _temp(log: LogOption): [LogOption, string] {
  return [log, buildSearchableText(log)];
}
function extractSearchableText(message: SerializedMessage): string {
  // Only extract from user and assistant messages that have content
  if (message.type !== 'user' && message.type !== 'assistant') {
    return '';
  }
  const content = 'message' in message ? message.message?.content : undefined;
  if (!content) return '';

  // Handle string content (simple messages)
  if (typeof content === 'string') {
    return content;
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block;
      if ('text' in block && typeof block.text === 'string') return block.text;
      return '';
      // we don't return thinking blocks and tool names here;
      // they're not useful for search, as they can add noise to the fuzzy matching
    }).filter(Boolean).join(' ');
  }
  return '';
}

/**
 * Builds searchable text for a log including messages, titles, summaries, and metadata.
 * Crops long transcripts to first/last N messages for performance.
 */
function buildSearchableText(log: LogOption): string {
  const searchableMessages = log.messages.length <= DEEP_SEARCH_MAX_MESSAGES ? log.messages : [...log.messages.slice(0, DEEP_SEARCH_CROP_SIZE), ...log.messages.slice(-DEEP_SEARCH_CROP_SIZE)];
  const messageText = searchableMessages.map(extractSearchableText).filter(Boolean).join(' ');
  const metadata = [getResumeLogDisplayTitle(log), log.customTitle, log.sessionBranch?.branchName, log.summary, log.firstPrompt, log.gitBranch, log.tag, log.prNumber ? `PR #${log.prNumber}` : undefined, log.prRepository].filter(Boolean).join(' ');
  const fullText = `${metadata} ${messageText}`.trim();
  return fullText.length > DEEP_SEARCH_MAX_TEXT_LENGTH ? fullText.slice(0, DEEP_SEARCH_MAX_TEXT_LENGTH) : fullText;
}
export function groupLogsByResumeBranch(filteredLogs: LogOption[]): ResumeLogGroup[] {
  type MutableGroup = {
    id: string;
    headerSessionId: string;
    logs: LogOption[];
    firstIndex: number;
  };

  const visibleSessionIds = new Set<string>();
  for (const log of filteredLogs) {
    const sessionId = getSessionIdFromLog(log);
    if (sessionId) visibleSessionIds.add(sessionId);
  }

  const groups = new Map<string, MutableGroup>();
  for (const [index, log] of filteredLogs.entries()) {
    const sessionId = getSessionIdFromLog(log);
    if (!sessionId) continue;

    const branch = log.sessionBranch;
    let headerSessionId = sessionId;
    if (branch?.rootSessionId && visibleSessionIds.has(branch.rootSessionId)) {
      headerSessionId = branch.rootSessionId;
    } else if (branch?.parentSessionId && visibleSessionIds.has(branch.parentSessionId)) {
      headerSessionId = branch.parentSessionId;
    }

    let group = groups.get(headerSessionId);
    if (!group) {
      group = {
        id: headerSessionId,
        headerSessionId,
        logs: [],
        firstIndex: index,
      };
      groups.set(headerSessionId, group);
    } else {
      group.firstIndex = Math.min(group.firstIndex, index);
    }
    group.logs.push(log);
  }

  return Array.from(groups.values()).map(group => {
    const headerLog =
      group.logs.find(log => getSessionIdFromLog(log) === group.headerSessionId) ??
      group.logs[0]!;
    const childLogs = group.logs.filter(log => log !== headerLog);
    return {
      id: group.id,
      headerLog,
      childLogs,
      logs: [headerLog, ...childLogs],
      firstIndex: group.firstIndex,
    };
  }).sort((a, b) => a.firstIndex - b.firstIndex);
}

/**
 * Get unique tags from a list of logs, sorted alphabetically
 */
function getUniqueTags(logs: LogOption[]): string[] {
  const tags = new Set<string>();
  for (const log of logs) {
    if (log.tag) {
      tags.add(log.tag);
    }
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}
