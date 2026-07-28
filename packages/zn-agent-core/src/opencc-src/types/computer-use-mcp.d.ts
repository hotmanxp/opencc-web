declare module '@ant/computer-use-mcp' {
  export interface ComputerExecutor {
    computer: unknown;
  }
  export interface DisplayGeometry {
    width: number;
    height: number;
    top: number;
    left: number;
  }
  export interface FrontmostApp {
    bundleId: string;
    name: string;
  }
  export interface InstalledApp {
    bundleId: string;
    name: string;
  }
  export interface ResolvePrepareCaptureResult {
    displayGeometry: DisplayGeometry;
  }
  export interface RunningApp {
    bundleId: string;
    name: string;
  }
  export interface ScreenshotResult {
    base64Image: string;
  }
  export const API_RESIZE_PARAMS: Record<string, unknown>;
  export const targetImageSize: { width: number; height: number };

  export function buildComputerUseTools(): unknown[];
  export function createComputerUseMcpServer(opts?: unknown): unknown;
}

declare module '@ant/computer-use-mcp/types' {
  export interface ComputerUseHostAdapter {
    onScreenChange?: () => void;
  }
  export interface Logger {
    info(msg: string): void;
    error(msg: string): void;
  }
}

declare module '@ant/computer-use-input' {
  export interface ComputerUseInput {
    start(): void;
    stop(): void;
  }
  export interface ComputerUseInputAPI {
    onInput(cb: (input: string) => void): void;
  }
}
