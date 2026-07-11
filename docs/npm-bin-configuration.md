# npm bin 配置问题总结

## 问题描述

在发布 `@zn-ai/zn-nova-connector` 包时，遇到 npx 命令无法找到的问题：

```bash
$ npx @zn-ai/zn-nova-connector
sh: zn-nova-connector: command not found
```

虽然 `npm view` 显示 bin 配置正确存在，但 npx 执行时找不到命令。

## 问题分析

### 1. 错误尝试：bin 指向 bin/ 目录下的文件

最初尝试将 bin 指向 `bin/zn-nova-connector.js`：

```json
{
  "bin": {
    "zn-nova-connector": "./bin/zn-nova-connector.js"
  }
}
```

**结果**：npm 发布时警告并移除该配置
```
npm warn publish "bin[zn-nova-connector]" script name bin/zn-nova-connector.js was invalid and removed
```

### 2. 错误尝试：使用 CommonJS 包装器

尝试使用 `.cjs` 扩展名的 CommonJS 文件作为 bin 入口：

```json
{
  "bin": {
    "zn-nova-connector": "./bin/zn-nova-connector.cjs"
  }
}
```

**结果**：npm 同样移除该配置
```
npm warn publish "bin[zn-nova-connector]" script name bin/zn-nova-connector.cjs was invalid and removed
```

### 3. 错误尝试：bin 指向 dist 目录但 files 包含 bin

当 bin 指向 `dist/cli.js` 但 `files` 数组包含 `"bin"` 目录时，npm 同样会移除 bin 配置。

## 根本原因

**npm 对 bin 目录有特殊验证逻辑**：当 `files` 数组包含 `bin` 目录时，npm 会认为你在尝试发布一个 bin 目录，并对其中的文件进行额外的名称验证。这个验证会拒绝大多数看起来"正常"的脚本名称。

## 解决方案

### 正确配置

参考 `@zn-ai/agent-login` 包的成功经验：

```json
{
  "name": "@zn-ai/zn-nova-connector",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "zn-nova-connector": "./dist/cli.js"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ]
}
```

**关键点**：
1. `bin` 指向 `dist/cli.js`，而非 `bin/` 目录
2. `files` 数组**不包含** `bin` 目录
3. CLI 入口文件需要在 build 时复制到 dist 目录

### package.json scripts 配置

```json
{
  "scripts": {
    "build": "tsc && cp bin/zn-nova-connector.js dist/cli.js && chmod +x dist/cli.js"
  }
}
```

### CLI 入口文件（ESM）

```javascript
#!/usr/bin/env node
/**
 * zn-nova-connector CLI 入口 (ESM)
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 计算当前脚本所在的目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 使用绝对路径确保在任何工作目录下都能正确找到 dist/index.js
const distPath = path.resolve(__dirname, '..', 'dist', 'index.js');
const url = pathToFileURL(distPath);

const mod = await import(url);
if (mod.default) {
  mod.default();
}
```

**注意**：由于包的 `type` 是 `module`，bin 文件会被当作 ESM 模块执行，因此必须：
- 使用 ESM 语法（`import` 而非 `require`）
- 使用 `import.meta.url` 和 `fileURLToPath` 计算 `__dirname`

## 验证步骤

1. 检查 npm view 输出中的 bin 字段：
   ```bash
   npm view @zn-ai/zn-nova-connector bin --registry=https://maven.paic.com.cn/repository/npm/
   ```

2. 解包 tarball 验证文件结构：
   ```bash
   npm pack @zn-ai/zn-nova-connector --pack-destination /tmp/test
   tar -tzf /tmp/test/zn-ai-zn-nova-connector-*.tgz | grep bin
   ```

3. 本地测试安装：
   ```bash
   cd /tmp && mkdir test-dir && cd test-dir
   npm init -y >/dev/null 2>&1
   npm install @zn-ai/zn-nova-connector@0.1.11 --registry=https://maven.paic.com.cn/repository/npm/
   npx zn-nova-connector
   ```

## 相关文件

- [packages/zn-nova-connector/package.json](../../packages/zn-nova-connector/package.json)
- [packages/zn-nova-connector/bin/zn-nova-connector.js](../../packages/zn-nova-connector/bin/zn-nova-connector.js)
- [packages/zn-nova-connector/dist/cli.js](../../packages/zn-nova-connector/dist/cli.js)
