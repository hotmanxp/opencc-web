本指南介绍如何安装和配置三款 AI CLI 工具：Nova CLI 、OpenCC 和 OpenCode CLI。

---

## 环境要求

### Node.js 版本

- **最低要求**: Node.js 20+
- **推荐版本**: Node.js 22.x（可直接安装，避免后续更新）

### 支持平台

- macOS
- Windows
- Linux

---

## 安装前准备

### 1. 配置 npm 源

设置平安镜像源以提高下载速度：

```bash
npm config set registry http://maven.paic.com.cn/repository/npm/
```

### 2. 全局安装权限问题（可选）

如果在安装全局包时遇到权限问题，可以自定义全局包安装路径：

```bash
npm config set prefix ~/nodejs/node_global
```

然后在 `~/.zshrc`（macOS/Linux）中添加环境变量：

```bash
export PATH=$PATH:$HOME/nodejs/node_global/bin
# 禁用 OpenCode 模型自动获取
export OPENCODE_DISABLE_MODELS_FETCH=1
```

重新加载配置：

```bash
source ~/.zshrc
```

**Windows自定义全局包安装路径：**

```
npm config set prefix "%USERPROFILE%\nodejs\node_global"
```

添加环境变量：系统属性-高级-环境变量，用户变量Path中添加路径：%USERPROFILE%\nodejs\node_global  在软件超市 安装 【环境变量】工具修改环境变量。修改后需要重启电脑

---

## 安装步骤

### 1. 安装三个 CLI 工具

```bash
# 安装 Nova CLI
npm install -g @zn-ai/nova

# 安装 OpenCode CLI
npm install -g opencode-ai

# 安装 OpenCC
npm install -g @zn-ai/opencc
```

### 2. 安装登录插件

```bash
npm install -g @zn-ai/agent-login@latest
```

### 3. 执行登录

```bash
npx @zn-ai/agent-login@latest
```

### 4. OpenCode 配置 agent-login 插件

OpenCode 支持通过配置文件自动加载插件。配置 agent-login 插件后，每次启动 OpenCode 会自动调用插件登录 PA 神兵。

#### 配置方法

##### 步骤 1：创建配置目录并安装插件

```bash
cd ~/.config/opencode
bun install @zn-ai/agent-login@latest
# or
npm install  @zn-ai/agent-login@latest
```

##### 步骤 2：创建配置文件

在 `~/.config/opencode` 目录下创建 `opencode.json` 文件，若已存在，直接增加以下配置：

```json
{
    "plugin": [
        "@zn-ai/agent-login",
        "oh-my-opencode"
     ]
}
```

##### 说明

`@zn-ai/agent-login`：PA 神兵登录插件
`oh-my-opencode`：OpenCode 增强插件

##### 效果

每次启动 OpenCode 时，agent-login 插件会自动执行，无需手动调用登录命令。

### OpenCC登录配置

安装后，先在用户目录下添加配置文件，~/.claude/settings.json，配置文件内容：

```
{"env": {
"ANTHROPIC_AUTH_TOKEN": "",
"API_TIMEOUT_MS": "3000000",
"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
"ANTHROPIC_BASE_URL": "https://zn-nova.paic.com.cn/novai",
"ANTHROPIC_MODEL": "qwen3.6-plus",
"ANTHROPIC_SMALL_FAST_MODEL": "MiniMax-M2.7-highspeed",
"ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2.7-highspeed"
}}
```

再执行开放平台登录

```bash
npx @zn-ai/agent-login@latest op
```

打开opencc，执行

```
opencc
```

---

## 验证安装

安装完成后，执行以下命令验证：

```bash
nova      # 启动 Nova CLI
opencode  # 启动 OpenCode CLI
opencc    # 启动 OpenCC
```

如果能正常启动，说明安装成功。

## 模型切换（PUB-GLM-4.7）--- 忽略本项目，工具已自动配置模型

**nova：**

启动nova，输入/settings，找到模型名称，输入：PUB-GLM-4.7

**opencode**：

启动opencode，输入/models，选择模型：PUB-GLM-4.7

---

## 常见问题

### 1. Windows 软件超市安装限制

**问题**：通过软件超市安装的 Node.js 无法使用 `-g` 全局安装

**解决方案**：

```bash
npm config set prefix userData/node-global
```

然后在系统环境变量中添加对应的路径到 PATH。

### 2. 权限问题

**问题**：安装全局包时报权限错误

**解决方案**：

- 方案一：自定义全局安装路径（见"安装前准备"部分）
- 方案二：使用 `sudo`（macOS/Linux，不推荐）
- 方案三：使用 nvm 管理 Node.js 版本

### 3. 命令找不到

**问题**：安装后执行命令提示 "command not found"

**解决方案**：

1. 检查全局安装路径：`npm config get prefix`
2. 确认路径已添加到 PATH 环境变量
3. 重新加载 shell 配置文件

### 4. 工具启动过慢

**问题：**在命令窗启动gemini，nova时间过长

**解决方案：**

1. 在工程目录下，打开命令窗，启动工具

### 5. OpenCode 启动报错

如果遇到启动错误，请：

1. 检查 Node.js 版本是否满足要求（20+）
2. 清除 npm 缓存：`npm cache clean --force`
3. 重新安装：`npm uninstall -g opencode-ai && npm install -g opencode-ai`

---

## 工具说明

### Nova CLI (@zn-ai/nova)

- 功能：知鸟团队自研的 AI CLI 工具
- 启动命令：`nova`
- 特点：集成知鸟内部能力和工作流

### OpenCode CLI (opencode-ai)

- 功能：代码级 AI 编程助手
- 启动命令：`opencode`
- 特点：专注于代码理解和生成

### OpenCC(@zn-ai/opencc)

- 功能：Claude Code 功能对标
- 启动命令：`opencc`
- 特点：支持 AGENTS.md 和 ~/.agents/skils/ 全平台资源

---

## 相关资源

- 平安内部文档：https://docs.paic.com.cn/#/post/115674103
- 软件超市：可搜索相关 Node.js 包

---

## 维护者

ZN-AI Team

最后更新：2026 年 2 月
