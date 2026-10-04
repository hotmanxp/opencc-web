// @ts-nocheck
import figures from 'figures';
import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { MCPRemoteServerMenu } from '../../components/mcp/MCPRemoteServerMenu.js';
import { MCPStdioServerMenu } from '../../components/mcp/MCPStdioServerMenu.js';
import { MCPToolDetailView } from '../../components/mcp/MCPToolDetailView.js';
import { MCPToolListView } from '../../components/mcp/MCPToolListView.js';
import type { ClaudeAIServerInfo, HTTPServerInfo, SSEServerInfo, StdioServerInfo } from '../../components/mcp/types.js';
import { SearchBox } from '../../components/SearchBox.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- useInput needed for raw search mode text input
import { Box, Text, useInput, useTerminalFocus } from '../../ink.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import { getBuiltinPluginDefinition } from '../../plugins/builtinPlugins.js';
import { useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js';
import type { MCPServerConnection, McpClaudeAIProxyServerConfig, McpHTTPServerConfig, McpSSEServerConfig, McpStdioServerConfig } from '../../services/mcp/types.js';
import { filterToolsByServer } from '../../services/mcp/utils.js';
import { disablePluginOp, enablePluginOp, getPluginInstallationFromV2, isInstallableScope, isPluginEnabledAtProjectScope, uninstallPluginOp, updatePluginOp } from '../../services/plugins/pluginOperations.js';
import { useAppState } from '../../state/AppState.js';
import type { Tool } from '../../Tool.js';
import type { LoadedPlugin, PluginError } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { openBrowser } from '../../utils/browser.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage, toError } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';
import { getMarketplace } from '../../utils/plugins/marketplaceManager.js';
import { isMcpbSource, loadMcpbFile, type McpbNeedsConfigResult, type UserConfigValues } from '../../utils/plugins/mcpbHandler.js';
import { getPluginDataDirSize, pluginDataDirPath } from '../../utils/plugins/pluginDirectories.js';
import { getFlaggedPlugins, markFlaggedPluginsSeen, removeFlaggedPlugin } from '../../utils/plugins/pluginFlagging.js';
import { type PersistablePluginScope, parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import { loadPluginOptions, type PluginOptionSchema, savePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js';
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js';
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js';
import { getSettings_DEPRECATED, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { plural } from '../../utils/stringUtils.js';
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js';
import { PluginOptionsDialog } from './PluginOptionsDialog.js';
import { PluginOptionsFlow } from './PluginOptionsFlow.js';
import type { ViewState as ParentViewState } from './types.js';
import { UnifiedInstalledCell } from './UnifiedInstalledCell.js';
import type { UnifiedInstalledItem } from './unifiedTypes.js';
import { usePagination } from './usePagination.js';
type Props = {
  setViewState: (state: ParentViewState) => void;
  setResult: (result: string | null) => void;
  onManageComplete?: () => void | Promise<void>;
  onSearchModeChange?: (isActive: boolean) => void;
  targetPlugin?: string;
  targetMarketplace?: string;
  action?: 'enable' | 'disable' | 'uninstall';
};
type FlaggedPluginInfo = {
  id: string;
  name: string;
  marketplace: string;
  reason: string;
  text: string;
  flaggedAt: string;
};
type FailedPluginInfo = {
  id: string;
  name: string;
  marketplace: string;
  errors: PluginError[];
  scope: PersistablePluginScope;
};
type ViewState = 'plugin-list' | 'plugin-details' | 'configuring' | {
  type: 'plugin-options';
} | {
  type: 'configuring-options';
  schema: PluginOptionSchema;
} | 'confirm-project-uninstall' | {
  type: 'confirm-data-cleanup';
  size: {
    bytes: number;
    human: string;
  };
} | {
  type: 'flagged-detail';
  plugin: FlaggedPluginInfo;
} | {
  type: 'failed-plugin-details';
  plugin: FailedPluginInfo;
} | {
  type: 'mcp-detail';
  client: MCPServerConnection;
} | {
  type: 'mcp-tools';
  client: MCPServerConnection;
} | {
  type: 'mcp-tool-detail';
  client: MCPServerConnection;
  tool: Tool;
};
type MarketplaceInfo = {
  name: string;
  installedPlugins: LoadedPlugin[];
  enabledCount?: number;
  disabledCount?: number;
};
type PluginState = {
  plugin: LoadedPlugin;
  marketplace: string;
  scope?: 'user' | 'project' | 'local' | 'managed' | 'builtin';
  pendingEnable?: boolean; // Toggle enable/disable
  pendingUpdate?: boolean; // Marked for update
};

/**
 * Get list of base file names (without .md extension) from a directory
 * @param dirPath The directory path to list files from
 * @returns Array of base file names without .md extension
 * @example
 * // Given directory contains: agent-sdk-verifier-py.md, agent-sdk-verifier-ts.md, README.txt
 * await getBaseFileNames('/path/to/agents')
 * // Returns: ['agent-sdk-verifier-py', 'agent-sdk-verifier-ts']
 */
async function getBaseFileNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, {
      withFileTypes: true
    });
    return entries.filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.md')).map((entry: Dirent) => {
      // Remove .md extension specifically
      const baseName = path.basename(entry.name, '.md');
      return baseName;
    });
  } catch (error) {
    const errorMsg = errorMessage(error);
    logForDebugging(`Failed to read plugin components from ${dirPath}: ${errorMsg}`, {
      level: 'error'
    });
    logError(toError(error));
    // Return empty array to allow graceful degradation - plugin details can still be shown
    return [];
  }
}

/**
 * Get list of skill directory names from a skills directory
 * Skills are directories containing a SKILL.md file
 * @param dirPath The skills directory path to scan
 * @returns Array of skill directory names that contain SKILL.md
 * @example
 * // Given directory contains: my-skill/SKILL.md, another-skill/SKILL.md, README.txt
 * await getSkillDirNames('/path/to/skills')
 * // Returns: ['my-skill', 'another-skill']
 */
async function getSkillDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, {
      withFileTypes: true
    });
    const skillNames: string[] = [];
    for (const entry of entries) {
      // Check if it's a directory or symlink (symlinks may point to skill directories)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Check if this directory contains a SKILL.md file
        const skillFilePath = path.join(dirPath, entry.name, 'SKILL.md');
        try {
          const st = await fs.stat(skillFilePath);
          if (st.isFile()) {
            skillNames.push(entry.name);
          }
        } catch {
          // No SKILL.md file in this directory, skip it
        }
      }
    }
    return skillNames;
  } catch (error) {
    const errorMsg = errorMessage(error);
    logForDebugging(`Failed to read skill directories from ${dirPath}: ${errorMsg}`, {
      level: 'error'
    });
    logError(toError(error));
    // Return empty array to allow graceful degradation - plugin details can still be shown
    return [];
  }
}

// Component to display installed plugin components
function PluginComponentsDisplay({
  plugin,
  marketplace
}: {
  plugin: LoadedPlugin;
  marketplace: string;
}): React.ReactNode | null {
  return null;
}

/**
 * Check if a plugin is from a local source and cannot be remotely updated
 * @returns Error message if local, null if remote/updatable
 */
async function checkIfLocalPlugin(pluginName: string, marketplaceName: string): Promise<string | null> {
  const marketplace = await getMarketplace(marketplaceName);
  const entry = marketplace?.plugins.find(p => p.name === pluginName);
  if (entry && typeof entry.source === 'string') {
    return `Local plugins cannot be updated remotely. To update, modify the source at: ${entry.source}`;
  }
  return null;
}

/**
 * Filter out plugins that are force-disabled by org policy (policySettings).
 * These are blocked by the organization and cannot be re-enabled by the user.
 * Checks policySettings directly rather than installation scope, since managed
 * settings don't create installation records with scope 'managed'.
 */
export function filterManagedDisabledPlugins(plugins: LoadedPlugin[]): LoadedPlugin[] {
  return plugins.filter(plugin => {
    const marketplace = plugin.source.split('@')[1] || 'local';
    return !isPluginBlockedByPolicy(`${plugin.name}@${marketplace}`);
  });
}
export function ManagePlugins({
  setViewState: setParentViewState,
  setResult,
  onManageComplete,
  onSearchModeChange,
  targetPlugin,
  targetMarketplace,
  action
}: Props): React.ReactNode | null {
  // App state for MCP access
  return null;
}
