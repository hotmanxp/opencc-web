# Chrome DevTools MCP 配置指南

Chrome DevTools MCP 是一个强大的工具，允许 AI 助手通过 Model Context Protocol (MCP) 与 Chrome 浏览器交互，实现自动化测试、网页抓取、性能分析等功能。

## 目录

- [浏览器配置](#浏览器配置)
  - [macOS 配置](#macos-配置)
  - [Windows 配置](#windows-配置)
- [Nova CLI 配置](#nova-cli-配置)
- [OpenCode 配置](#opencode-配置)
- [zai 配置](#zai-配置)
- [使用示例](#使用示例)
- [常用场景](#常用场景)
  - [Web 开发调试](#web-开发调试)
  - [办公自动化辅助](#办公自动化辅助)
- [常见问题](#常见问题)

---

## 浏览器配置

### macOS 配置

在 macOS 上，需要在 `~/.bash_profile` 或 `~/.zshrc` 中添加 Chrome 启动配置：

```bash
# ~/.bash_profile 或 ~/.zshrc

# Chrome 调试模式启动别名
# 参数说明:
# --remote-debugging-port=9223  启用远程调试端口
# --user-data-dir=/tmp/chrome-dev-profile  使用独立的用户数据目录（可选，避免与现有 Chrome 冲突）
alias chrome-dev="/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9223 --user-data-dir=/tmp/chrome-dev-profile"

# 快速启动函数
start-chrome-dev() {
    echo "正在启动 Chrome 调试模式..."
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome 
        --remote-debugging-port=9223 
        --user-data-dir=/tmp/chrome-dev-profile 
        &
    echo "Chrome 已启动，调试端口：http://127.0.0.1:9223"
}
```

**使用方法：**

```bash
# 方式 1: 使用别名
chrome-dev

# 方式 2: 使用函数
start-chrome-dev

# 方式 3: 直接命令
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9223 --user-data-dir=/tmp/chrome-dev-profile
```

**验证 Chrome 是否启动成功：**

访问 `http://127.0.0.1:9223/json` 查看可用的调试目标列表。

---

### Windows 配置

在 Windows 上，创建 Chrome 快捷方式来启动调试模式：

#### 方法 1: 创建桌面快捷方式

1. **右键点击桌面** → **新建** → **快捷方式**

2. **输入位置**（根据你的 Chrome 安装路径调整）：
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="C:	emp\chrome-dev-profile"
   ```

   **常见安装路径：**
   - 标准安装：`C:\Program Files\Google\Chrome\Application\chrome.exe`
   - 32 位系统：`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
   - 用户安装：`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`

3. **命名快捷方式**：例如 "Chrome 调试模式"

4. **可选 - 设置图标**：
   - 右键快捷方式 → **属性** → **更改图标**
   - 选择 Chrome 图标

#### 方法 2: 创建批处理文件

创建 `start-chrome-dev.bat` 文件：

```batch
@echo off
echo 正在启动 Chrome 调试模式...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="C:	emp\chrome-dev-profile"
echo Chrome 已启动，调试端口：http://127.0.0.1:9223
```

**使用方法：**
- 双击运行批处理文件
- 或将其添加到系统 PATH 后在命令行运行

#### 方法 3: PowerShell 脚本

创建 `Start-ChromeDev.ps1` 文件：

```powershell
# Start-ChromeDev.ps1
Write-Host "正在启动 Chrome 调试模式..." -ForegroundColor Green

$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$debugPort = 9223
$userDataDir = "C:	emp\chrome-dev-profile"

# 确保用户数据目录存在
if (!(Test-Path $userDataDir)) {
    New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
}

# 启动 Chrome
Start-Process -FilePath $chromePath `
              -ArgumentList "--remote-debugging-port=$debugPort", "--user-data-dir=$userDataDir" `
              -WindowStyle Normal

Write-Host "Chrome 已启动，调试端口：http://127.0.0.1:$debugPort" -ForegroundColor Green
Write-Host "访问 http://127.0.0.1:$debugPort/json 查看调试目标" -ForegroundColor Cyan
```

**使用方法：**
```powershell
# 在 PowerShell 中运行
.\Start-ChromeDev.ps1
```

---

## Nova CLI 配置

在 Nova CLI 中配置 Chrome DevTools MCP，需要编辑 `~/.nova/policies/auto-saved.toml` 文件：

```toml
# ~/.nova/policies/auto-saved.toml

[mcpServers.chrome-devtools-mcp]
command = "chrome-devtools-mcp"
args = [
  "--auto-connect",
  "--browserUrl=http://127.0.0.1:9223"
]
```

**配置说明：**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `command` | MCP 服务器命令 | `chrome-devtools-mcp` |
| `args` | 命令行参数数组 | - |
| `--auto-connect` | 自动连接到浏览器 | 必需 |
| `--browserUrl` | Chrome 调试端点 URL | `http://127.0.0.1:9223` |

**验证配置：**

1. 启动 Chrome 调试模式（参考上方浏览器配置）
2. 打开 Nova CLI
3. 运行以下命令验证连接：
   ```
   /mcp list
   ```

---

## OpenCode 配置

在 OpenCode 中配置 Chrome DevTools MCP，需要编辑 `~/.config/opencode/opencode.json` 文件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chrome-devtools-mcp": {
      "type": "local",
      "command": [
        "chrome-devtools-mcp",
        "--auto-connect",
        "--browserUrl=http://127.0.0.1:9223"
      ],
      "enabled": true
    }
  }
}
```

**配置说明：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | MCP 服务器类型，必须是 `"local"` |
| `command` | array | 命令和参数数组 |
| `enabled` | boolean | 是否启用此 MCP 服务器 |

**安装 chrome-devtools-mcp：**

```bash
# 全局安装
npm install -g chrome-devtools-mcp

# 或使用 npx 直接运行
npx chrome-devtools-mcp
```

**验证配置：**

1. 确保 Chrome 调试模式已启动
2. 在 OpenCode 中使用以下提示：
   ```
   使用 chrome-devtools-mcp 工具打开 https://www.zhi-niao.com
   ```

---

## zai 配置

zai 通过项目级 `.mcp.json` 或用户级 `~/.zai.json` / `~/.claude.json` 自动发现 chrome-devtools-mcp。zai **尊重 Claude Code 的 MCP 过滤字段**(`packages/zai/src/server/services/mcpConfig.ts:88-108`):

```jsonc
// .mcp.json — 最小可用配置
{
  "mcpServers": {
   "chrome-devtools-mcp": {
     "command": "chrome-devtools-mcp",
     "args": ["--auto-connect", "--browserUrl=http://127.0.0.1:9223"]
   }
  }
}
```

**过滤行为:**

| 字段 | 位置 | 效果 |
|---|---|---|
| `enabledMcpjsonServers` | `.mcp.json` | allowlist — 只加载列表中的 server(空数组 ⇒ 全部禁用) |
| `disabledMcpjsonServers` | `.mcp.json` | blocklist — 移除列表中的 server(与 enabled 互斥) |
| `disabledMcpServers` | `~/.zai.json` / `~/.claude.json` | 全局黑名单 — post-merge 过滤,user 压过 project allowlist |

**注意:** enterprise scope(`ZAI_MANAGED_MCP_CONFIG` / `/etc/zai/managed-mcp.json`)一旦命中即 exclusive,**不被 `disabledMcpServers` 影响**。

zai 启动时会自动为 chrome-devtools-mcp 注入 `roots: [cwd]`,避免 "did not negotiate the MCP roots capability" 警告。

Plan: `docs/superpowers/plans/2026-07-20-zai-mcp-disabled-servers.md`

---

## 使用示例

### Nova CLI 示例

#### 1. 导航到网页

```
使用 chrome-devtools-mcp 打开 https://code.paic.com.cn/#/manage/home/repos/list
```

#### 2. 页面截图

```
截取当前页面的全屏截图并保存
```

#### 3. 执行 JavaScript

```
在当前页面执行 JavaScript：document.title
```

#### 4. 填写表单

```
找到搜索框并输入 "test query"，然后按 Enter 键
```

#### 5. 性能分析

```
对当前页面进行性能分析，找出加载缓慢的原因
```

---

### OpenCode 示例

#### 1. 基本页面操作

```
使用 chrome-devtools-mcp 工具访问 https://code.paic.com.cn/#/manage/home/repos/list 并获取页面标题
```

#### 2. 网络请求监控

```
监控当前页面的所有网络请求，列出失败的请求
```

#### 3. 控制台日志

```
获取当前页面的所有控制台日志消息
```

#### 4. 元素交互

```
点击页面中 提交 的按钮
```

---

## 常用场景

### Web 开发调试

让 Agent 自动化完成 Web 开发调试工作，快速定位问题并验证功能。

#### 场景 1: 自动获取报错信息

**问题诊断 - 控制台错误收集**

```
访问 https://code.paic.com.cn/#/manage/home/repos/list 并获取所有控制台错误和警告信息，分析报错原因
```

**示例输出：**
```javascript
// Agent 会自动：
// 1. 打开页面
// 2. 获取控制台日志
// 3. 分析错误堆栈
// 4. 提供修复建议

发现错误：
- TypeError: Cannot read property 'x' of undefined (line 45:12)
- Warning: Each child in a list should have a unique "key" prop

修复建议：
1. 在 line 45 添加空值检查
2. 为列表项添加 key 属性
```

**网络请求错误分析**

```
监控页面加载，找出所有失败的 API 请求，并分析失败原因
```

**示例输出：**
```
失败的请求：
1. GET /api/users - 404 Not Found
2. POST /api/login - 500 Internal Server Error

分析：
- 404: 接口路径可能拼写错误或后端路由未配置
- 500: 后端服务器内部错误，检查后端日志
```

#### 场景 2: 功能验证自动化

**表单验证测试**

```
访问登录页面，验证以下测试用例：
1. 空用户名和密码提交
2. 正确的用户名和错误的密码
3. 正确的用户名和密码

记录每个测试的预期结果和实际结果
```

**Agent 执行流程：**
```javascript
// 1. 打开登录页面
navigate_page: https://code.paic.com.cn/#/manage/home/repos/list

// 2. 测试空凭证
fill: username = ""
fill: password = ""
click: 登录按钮
verify: 显示"用户名不能为空"提示

// 3. 测试错误密码
fill: username = "test@example.com"
fill: password = "wrongpassword"
click: 登录按钮
verify: 显示"密码错误"提示

// 4. 测试正确凭证
fill: username = "test@example.com"
fill: password = "correctpassword"
click: 登录按钮
verify: 跳转到首页
```

**输出测试报告：**
```
测试结果：
✅ 测试用例 1: 通过 - 正确显示验证错误
✅ 测试用例 2: 通过 - 正确显示密码错误提示
❌ 测试用例 3: 失败 - 未跳转到首页，页面仍然停留在登录页

建议：检查登录成功后的跳转逻辑
```

**组件交互验证**

```
访问商品详情页，验证以下功能：
1. 点击"加入购物车"按钮，购物车数量 +1
2. 点击收藏按钮，按钮状态变为已收藏
3. 滑动到评论区，评论列表正常加载

截图保存每个步骤的结果
```

**响应式布局验证**

```
在以下视口尺寸下测试页面布局：
- 手机模式：375x667
- 平板模式：768x1024
- 桌面模式：1920x1080

对每种尺寸截图并检查布局是否正常
```

#### 场景 3: 自动化调试流程

**完整调试工作流示例**

```
帮我调试这个页面：
1. 打开 https://code.paic.com.cn/#/manage/home/repos/list
2. 检查控制台错误
3. 检查失败的 API 请求
4. 测试主要的用户交互（按钮点击、表单提交）
5. 截图并生成调试报告
```

**性能问题诊断**

```
分析 https://www.zhi-niao.com 的页面性能：
1. 获取所有网络请求，找出加载最慢的资源
2. 检查是否有重复请求
3. 评估首屏加载时间
4. 提供优化建议
```

---

### 办公自动化辅助

通过自然语言指令完成网页系统的重复性操作，提高工作效率。

#### 场景 1: 一键数据录入

**批量表单填充**

```
帮我填写本周项目工时：
- 打开 http://zhgx.paic.com.cn/#/project/working-hour/fillout
- 登录
- 根据上个星期的填写记录填写本周工时

```


#### 场景 2: 定时监控与报告

**数据监控与采集**

```
访问 https://code.paic.com.cn/#/manage/home/repos/list
1. 获取当前的以下数据：
   - 今日新增仓库数
   - 活跃仓库数
   - 代码提交数
   - 协作成员数

2. 将数据格式化为以下报告格式：
   日期：2026-03-31
   新增仓库：[数据]
   活跃仓库：[数据]
   提交数：[数据]
   成员数：[数据]

3. 保存报告到 /Users/liangxuechao572/reports/daily_20260331.txt
```

**页面状态检查**

```
帮我检查以下服务是否正常：
1. 访问 https://code.paic.com.cn/#/manage/home/repos/list
2. 检查所有仓库的访问状态
3. 记录所有"访问异常"的仓库名称
4. 截图保存当前状态
5. 如果有异常，发送邮件提醒（使用邮件工具）
```

#### 场景 3: 重复任务自动化

**日报自动生成**

```
帮我生成今日工作日报：
1. 打开 https://code.paic.com.cn/#/manage/home/repos/list
2. 查询我今日创建的仓库
3. 查询今日的代码提交记录
4. 将以上信息整合成以下格式的工作日报：

---
## 2026 年 3 月 31 日 工作日报

### 创建的仓库
- [仓库名] [仓库地址]
- ...

### 代码提交
- [仓库名] [提交信息]
- ...

### 备注
[手动补充内容]
---

6. 将日报保存到 /Users/liangxuechao572/reports/daily_20260331.md
```

**定期数据同步**

```
帮我将代码仓库的数据同步到 Excel：
1. 访问 https://code.paic.com.cn/#/manage/home/repos/list
2. 导出所有仓库列表数据
3. 下载导出的文件
4. 将文件移动到 /Users/liangxuechao572/Documents/inventory/
5. 命名为 repos_YYYYMMDD.xlsx
```

#### 场景 4: 跨系统协作

**跨平台数据流转**

```
执行以下数据迁移流程：
1. 从 Git 系统导出数据：
   - 访问 https://code.paic.com.cn/#/manage/home/repos/list
   - 选择日期范围：2026-03-01 至 2026-03-31
   - 点击"导出为 CSV"

2. 处理导出文件：
   - 等待下载完成
   - 将文件移动到 /Users/liangxuechao572/temp/

3. 导入到文档系统：
   - 访问 https://doc.paic.com.cn/import
   - 上传刚才导出的文件
   - 点击"开始导入"
   - 等待导入完成
   - 截图保存导入结果
```

**仓库权限批量处理**

```
帮我批量处理今天的所有仓库权限申请：
1. 访问 https://code.paic.com.cn/#/manage/home/repos/list?status=pending
2. 对每个权限申请执行以下操作：
   a. 检查申请人信息
   b. 验证申请理由
   c. 如符合规范，点击"批准权限"
   d. 如不符合，点击"拒绝申请"
3. 处理完成后，截图保存权限列表
4. 生成处理汇总报告
```

#### 场景 5: 测试与验证

**回归测试自动化**

```
帮我执行以下回归测试：

测试环境：https://code.paic.com.cn/#/manage/home/repos/list
测试账号：tester / test123

测试用例 1 - 仓库列表查看
1. 打开仓库列表页
2. 输入用户名和密码
3. 点击登录
4. 验证跳转到仓库列表
5. 截图

测试用例 2 - 仓库搜索功能
1. 在搜索框输入"react"
2. 点击搜索
3. 验证搜索结果包含 react 仓库
4. 截图

测试用例 3 - 创建仓库
1. 点击"新建仓库"
2. 填写仓库信息
3. 点击创建
4. 验证仓库创建成功
5. 截图

生成测试报告并保存
```
5. 截图

测试用例 2 - 搜索功能
1. 在搜索框输入"iPhone"
2. 点击搜索
3. 验证搜索结果包含 iPhone
4. 截图

测试用例 3 - 购物车操作
1. 添加商品到购物车
2. 打开购物车
3. 验证商品已添加
4. 修改数量为 2
5. 验证总价更新
6. 截图

生成测试报告并保存
```

---

## 可用工具

Chrome DevTools MCP 提供以下工具：

| 工具名称 | 描述 |
|---------|------|
| `click` | 点击页面元素 |
| `fill` | 填充输入框 |
| `type_text` | 输入文本 |
| `press_key` | 按键操作 |
| `navigate_page` | 页面导航 |
| `take_screenshot` | 截取屏幕截图 |
| `take_snapshot` | 获取页面快照 |
| `list_console_messages` | 获取控制台消息 |
| `list_network_requests` | 获取网络请求列表 |
| `evaluate_script` | 执行 JavaScript 代码 |
| `resize_page` | 调整页面大小 |
| `emulate` | 模拟设备/网络条件 |

---

## 常见问题

### Q1: Chrome 无法启动

**解决方案：**
- macOS: 确保 Chrome 路径正确，使用 `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome`
- Windows: 检查 Chrome 安装路径，确保快捷方式中的路径正确
- 确认没有正在运行的 Chrome 实例冲突

### Q2: 连接失败 "Cannot connect to browser"

**解决方案：**
1. 验证 Chrome 是否已启动并启用调试模式
2. 访问 `http://127.0.0.1:9223/json` 确认服务可用
3. 检查端口 9223 是否被占用
4. 尝试更换端口号，如 `--remote-debugging-port=9222`

### Q3: MCP 命令未找到

**解决方案：**
```bash
# 全局安装
npm install -g chrome-devtools-mcp

# 或在配置中使用 npx
# Nova CLI:
[mcpServers.chrome-devtools-mcp]
command = "npx"
args = ["chrome-devtools-mcp", "--auto-connect", "--browserUrl=http://127.0.0.1:9223"]

# OpenCode:
"command": ["npx", "-y", "chrome-devtools-mcp", "--auto-connect", "--browserUrl=http://127.0.0.1:9223"]
```

### Q4: 用户数据目录权限问题

**解决方案：**
- macOS: 确保 `/tmp/chrome-dev-profile` 有写入权限
- Windows: 使用管理员权限运行，或更改目录到用户目录
  ```
  --user-data-dir="%LOCALAPPDATA%\chrome-dev-profile"
  ```

### Q5: 多个 Chrome 实例冲突

**解决方案：**
- 使用独立的 `--user-data-dir` 参数
- 关闭所有 Chrome 实例后重新启动
- 使用不同的端口号运行多个实例

---

## 高级配置

### 自定义端口和配置

```bash
# macOS - ~/.bash_profile
alias chrome-dev-9224="/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9224 --user-data-dir=/tmp/chrome-dev-9224"

# Windows - 批处理文件
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9224 --user-data-dir="C:	emp\chrome-dev-9224"
```

### 无头模式（Headless）

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome 
  --remote-debugging-port=9223 
  --headless 
  --user-data-dir=/tmp/chrome-dev-profile

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9223 ^
  --headless ^
  --user-data-dir="C:	emp\chrome-dev-profile"
```

### 禁用安全功能（仅开发环境）

```bash
--disable-web-security 
--allow-running-insecure-content
```

---

## 资源链接

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [MCP 官方文档](https://modelcontextprotocol.io/)
- [Nova CLI 文档](https://geminicli.com/)
- [OpenCode 文档](https://opencode.ai/docs/)

---

**维护者:** ZN-AI Team  
**最后更新:** 2026 年 7 月 20 日
