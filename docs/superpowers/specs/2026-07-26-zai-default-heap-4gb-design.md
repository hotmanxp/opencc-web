# zai 默认 Node.js 堆内存 4GB 设计

## 目标

让 zai 启动时默认使用 `--max-old-space-size=4096`，避免长会话和大 transcript 导致 Node.js 堆上限过低。同时保留用户显式配置的内存值。

## 范围

修改 `packages/zai/bin/zai.js` 启动包装器，并为启动参数解析与重启行为增加测试（如项目现有测试结构允许）。不修改业务运行时、API 或前端代码。

## 启动行为

1. 启动包装器检查当前进程的 `process.execArgv` 与 `NODE_OPTIONS`。
2. 如果任一处已经包含 `--max-old-space-size=<n>` 或 `--max_old_space_size=<n>`，直接加载 `dist/cli/index.js`，保留用户配置。
3. 如果没有显式配置，使用当前 Node 可执行文件，以 `--max-old-space-size=4096` 重启自身，并透传：
   - 原始命令行参数；
   - 当前环境变量；
   - stdin/stdout/stderr。
4. 子进程使用内部环境变量标记，防止重启循环。
5. 子进程退出后，父进程以相同退出码退出；信号退出时保留对应非零退出结果。
6. `zai`、`zai start`、`zai dev` 和显式 CLI 参数均沿用现有入口行为。

## 用户覆盖优先级

用户配置优先于默认值。支持：

```bash
NODE_OPTIONS=--max-old-space-size=8192 zai
node --max-old-space-size=8192 packages/zai/bin/zai.js
```

这两种情况下都不再额外注入 4096MB。

## 错误处理

如果自重启失败，输出明确错误并以非零状态退出；不得静默退回未设置堆上限的运行模式。

## 验证

- 静态检查启动包装器无 TypeScript/JavaScript 语法错误。
- 验证无显式参数时生成 4096MB 参数。
- 验证 `NODE_OPTIONS` 或 `process.execArgv` 已有堆参数时不重复注入。
- 验证 CLI 参数和退出码能够透传。
- 启动实际构建后的 zai，确认服务可以正常启动。
