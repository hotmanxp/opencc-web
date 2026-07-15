// Shared type definitions — single source of truth for backend + frontend

export interface SystemInfo {
  nodeVersion: string;
  nodeMajor: number;
  npmVersion: string | null;
  npmPrefix: string;
  npmRegistry: string;
  npmBinInPath: boolean;
  /** Node.js platform string: 'darwin' | 'linux' | 'win32' | ... */
  platform: NodeJS.Platform;
}

export interface CliStatus {
  name: 'nova' | 'opencode' | 'opencc' | 'agent-login' | 'codegraph' | 'zai';
  pkg: string;
  bin: string;
  installed: boolean;
  path: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
}

export interface DirectoryStatus {
  nova: DirInfo;
  opencode: DirInfo;
  opencc: DirInfo;
  globalSkills: DirInfo;
}

export interface DirInfo {
  path: string;
  exists: boolean;
  agents: FileCount;
  commands: FileCount;
  skills: FileCount;
  extensions: FileCount;
}

export interface FileCount {
  count: number;
  items: string[];
}

export type ResourceType = 'skills' | 'commands' | 'extensions' | 'agents';

export interface ResourceItem {
  name: string;
  type: ResourceType;
  /**
   * The version of the @zn-ai/plugin cache this resource was installed from,
   * or null if the resource isn't installed on disk yet. Set by
   * GET /api/resources/:type when the cached extraction is available.
   */
  installedVersion: string | null;
  /** Latest version known to the manifest (npm registry), or null if unknown. */
  latestVersion: string | null;
  /**
   * True when `name` is a collection (a directory grouping several
   * resources). UI shows "安装全部 (N 项)" instead of "安装", and the
   * server-side install expands the collection and installs every
   * contained resource in one shot.
   */
  isCollection?: boolean;
  /** Number of resources inside the collection. Only set when isCollection. */
  collectionSize?: number;
  /**
   * True when the collection represents a platform bucket
   * (commands/nova, agents/opencode, …). UI renders these as "平台"
   * folders; install logic routes them only to the matching platform.
   */
  isPlatformFolder?: boolean;
}

export interface ConfigFile {
  path: string;
  exists: boolean;
  content: Record<string, unknown>;
  missing?: boolean;
}

export type SseEventType = 'start' | 'stdout' | 'stderr' | 'exit' | 'error';

export interface SseEvent {
  type: SseEventType;
  command?: string;
  line?: string;
  code?: number;
  signal?: string;
  message?: string;
}

export type ConfigTool = 'nova' | 'opencode' | 'opencc';

/**
 * Per-model capability metadata, mirroring the shape used by OpenCC's
 * integration descriptors (src/integrations/descriptors.ts →
 * CapabilityFlags + ModelDescriptor.contextWindow/maxOutputTokens).
 *
 * All fields are optional — older providers saved before this schema
 * landed simply omit capabilities and the UI degrades gracefully.
 */
export interface ModelCapabilities {
  /** Max input tokens the model accepts in a single request. */
  contextWindow?: number;
  /** Max output tokens the model can emit per response. */
  maxOutputTokens?: number;
  /** Accepts image inputs (vision/multimodal). */
  supportsVision?: boolean;
  /** Supports tool/function calling. */
  supportsFunctionCalling?: boolean;
  /** Supports extended thinking / reasoning_effort control. */
  supportsReasoning?: boolean;
  /** Supports server-side JSON mode / structured outputs. */
  supportsJsonMode?: boolean;
  /** Supports token-by-token streaming responses. */
  supportsStreaming?: boolean;
}

export interface ProviderProfile {
  id?: string;
  name: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  apiFormat?: string;
  /**
   * Optional capability map keyed by model name. Lets the picker/UI
   * surface context window, vision support, etc. without a network
   * round-trip. Unrecognised keys are ignored.
   */
  capabilities?: Record<string, ModelCapabilities>;
}
export type LoginType = 'pa' | 'pa-long' | 'op';

export interface RegistryOption {
  key: string;
  label: string;
  url: string;
}

// Curated list of npm registries. Ordered: internal Ping An first so
// `npm config get registry` matches by default; mirrors by speed/usage;
// official last as the fallback. URLs are exactly what `npm config set
// registry` expects — trailing slash and protocol matter to npm.
export const KNOWN_REGISTRIES: RegistryOption[] = [
  { key: 'pingan', label: '平安内网', url: 'http://maven.paic.com.cn/repository/npm/' },
  { key: 'taobao', label: '淘宝镜像 (npmmirror)', url: 'https://registry.npmmirror.com/' },
  { key: 'tencent', label: '腾讯云镜像', url: 'https://mirrors.cloud.tencent.com/npm/' },
  { key: 'huawei', label: '华为云镜像', url: 'https://repo.huaweicloud.com/repository/npm/' },
  { key: 'npmjs', label: '官方 npmjs', url: 'https://registry.npmjs.org/' },
];
