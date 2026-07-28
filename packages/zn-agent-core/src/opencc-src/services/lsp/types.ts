export interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  rootUri?: string;
  workspaces?: string[];
  initializationOptions?: unknown;
  workspaceFolder?: string;
  extensionToLanguage?: Record<string, string>;
}

export interface LspServerState {
  status: 'stopped' | 'starting' | 'running' | 'error' | 'stopping';
  error?: string;
}

export interface ScopedLspServerConfig {
  server: LspServerConfig;
  scopes?: string[];
  restartOnCrash?: boolean;
  shutdownTimeout?: number;
  maxRestarts?: number;
  startupTimeout?: number;
}
