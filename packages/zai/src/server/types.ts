export interface AppOptions {
  token: string;
  port?: number;
  cwd: string;
  cwdName: string;
  host?: string;   // server bind host, 默认 '127.0.0.1', --lan 时 '0.0.0.0'
  /** SDK/headless mode (`zai --sdk`): treat the runtime as non-interactive. Default is interactive. */
  sdk?: boolean;
}
