export interface AppOptions {
  token: string;
  port?: number;
  cwd: string;
  cwdName: string;
  host?: string;   // server bind host, 默认 '127.0.0.1', --lan 时 '0.0.0.0'
  /** SDK/headless mode (`zai --sdk`): treat the runtime as non-interactive. Default is interactive. */
  sdk?: boolean;
  /**
   * 强制初始化 InstanceSupervisor,即使当前进程带有 `ZAI_INSTANCE_ID`
   * (即被 instance manager 派生的子进程)。默认行为:子实例不 init
   * (它在语义上不能再 spawn 孙实例,见 server/index.ts:90 + routes/instances.ts)。
   * 测试里使用此开关强制 init 验证完整 wiring — 因为 vitest 进程可能
   * 继承 shell 的 env,无法保证干净。
   */
  forceInitInstanceSupervisor?: boolean;
}
