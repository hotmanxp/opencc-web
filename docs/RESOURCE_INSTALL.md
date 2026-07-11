# zn-agent-assets 资源安装指南

**zn-agent-assets** 是 Nova CLI 的官方资源配置库，提供丰富的 Agents、Commands、Skills 和 Extensions，帮助你提升开发效率和工作流程。

---

## 🚀 安装方式

### 方式一：一键快速安装 ⚡

如果你需要快速获得最常用的资源，使用 Nova CLI 的一键安装命令：

```bash
# 安装所有 skills 和 commands
nova /resource-install
```

这将自动安装：
- ✅ 所有 Skills（包括推荐的 planning-with-files）
- ✅ 所有 Commands
- ❌ 不包含 Extensions（需要单独安装）

---

### 方式二：使用 zn-agent-plugin 工具安装 🔧

`zn-agent-plugin` 是官方资源发布工具，提供更灵活的安装选项。

#### 1. 安装 publish 工具

```bash
# 全局安装
npm install -g @zn-ai/plugin@latest
```

#### 2. 查看可用资源

```bash
# 列出所有资源类型
zn-agent-plugin list

# 列出特定类型的资源
zn-agent-plugin list skills
zn-agent-plugin list extensions
zn-agent-plugin list commands
zn-agent-plugin list agents

# 查看特定资源详情
zn-agent-plugin list skills planning-with-files
zn-agent-plugin list extensions task-with-files
```

#### 3. 安装资源

##### 安装到检测到的平台

```bash
# 安装所有资源到所有已安装的平台自动检测到
zn-agent-plugin install

# 安装特定类型的资源
zn-agent-plugin install skills
zn-agent-plugin install extensions
zn-agent-plugin install commands
zn-agent-plugin install agents

# 安装特定资源
zn-agent-plugin install skills planning-with-files
zn-agent-plugin install extensions task-with-files
```

##### 指定平台安装

```bash
# 只安装到 Nova CLI
zn-agent-plugin install --platform nova

# 只安装到 OpenCode
zn-agent-plugin install --platform opencode

# 安装到所有平台（无论是否检测到）
zn-agent-plugin install --platform all

# 组合使用
zn-agent-plugin install skills extensions --platform nova
```

#### 平台检测逻辑

`zn-agent-plugin` 会自动检测本地安装的平台：

- **Nova CLI**: 检查 `nova` 或 `gemini` 命令是否存在，或 `~/.nova` 目录是否存在
- **OpenCode**: 检查 `opencode` 命令是否存在，或 `~/.config/opencode` 目录是否存在

---

## 📋 安装目标目录

### Nova CLI

| 资源类型 | 源目录 | 安装目标 |
|---------|--------|----------|
| Agents | `assets/agents/` | `~/.nova/agents/` |
| Commands | `assets/commands/` | `~/.nova/commands/` |
| Skills | `assets/skills/` | `~/.nova/skills/` |
| Extensions | `assets/extensions/` | `~/.nova/extensions/` |

### OpenCode

| 资源类型 | 源目录 | 安装目标 |
|---------|--------|----------|
| Agents | `assets/agents/` | `~/.config/opencode/agents/` |
| Commands | `assets/commands/` | `~/.config/opencode/commands/` |
| Skills | `assets/skills/` | `~/.agents/skills/`（全局共享） |
| Extensions | - | 不支持 |

---

## ⭐ 推荐安装组合

### 最小化安装（日常开发）

```bash
# 快速安装核心资源
nova /resource-install

# 单独安装推荐的 extension（强烈推荐）
zn-agent-plugin install --platform nova extensions task-with-files
```

### 完整安装（全部功能）

```bash
# 安装所有资源
zn-agent-plugin install --platform all skills commands agents extensions
```

### 开发环境配置

```bash
# 安装所有 skills 和 commands
zn-agent-plugin install skills commands --platform nova

# 安装所有 extensions
zn-agent-plugin install extensions --platform nova

# 验证安装
nova extensions list
```

---

## 🔍 验证安装

### Nova CLI

```bash
# 列出所有 extensions
nova extensions list

# 列出所有 commands
nova commands list

# 查看 commands 详情
nova commands show <command-name>
```

### OpenCode

```bash
# 列出所有 extensions
opencode extensions list

# 列出所有 skills
opencode skills list
```

---

## 🔧 常见问题

### Q: 如何更新已安装的资源？

```bash
# 重新安装以更新
zn-agent-plugin install --platform all

# 或从源码仓库拉取最新代码后重新安装
git pull
zn-agent-plugin install --platform all
```

### Q: 如何卸载资源？

```bash
# 手动删除对应目录
rm -rf ~/.nova/extensions/task-with-files
rm -rf ~/.nova/skills/planning-with-files
```

### Q: 检测不到平台怎么办？

1. 确认已安装对应的 CLI:
   ```bash
   which nova
   which opencode
   ```

2. 检查目录是否存在:
   ```bash
   ls -la ~/.nova
   ls -la ~/.config/opencode
   ```

3. 使用 `--platform all` 强制安装到所有平台

### Q: Extension 安装失败怎么办？

1. 确认 `gemini-extension.json` 存在
2. 检查 extension name 是否与目录名匹配
3. 查看警告信息（名称不匹配会显示警告但不影响安装）
4. 检查目录权限

---

## 📦 可用资源概览

### 🤖 Agents (智能代理)

专业的 AI 代理配置，针对特定任务场景优化：

- **plan-agent** — 专业规划代理，用于创建详细的实施计划

### ⚡ Commands (命令)

一键执行的便捷命令，自动化常见工作流：

- **commit** — 自动生成提交信息并提交代码
- **install-extension** — 从 GitHub URL 或本地路径安装 Nova CLI 扩展

### 🛠️ Skills (技能模块)

为 Nova CLI 提供的专业技能，扩展 AI 的能力边界：

#### ⭐ 高度推荐安装
- **planning-with-files** — 基于文件的规划技能，使用 3 文件模式（task_plan.md, findings.md, progress.md）管理复杂多步骤任务

#### 文档与演示
- **doc-coauthoring** — 引导用户完成文档协作创作流程的三阶段工作流
- **docx** — Word 文档处理工具包，支持创建、编辑、评论、修订和格式管理
- **pdf** — PDF 处理工具包，支持提取、创建、合并、分割和表单处理
- **pptx** — PowerPoint 演示文稿创建、编辑和分析工具

#### 开发与工程
- **git-master** — Git 操作专家，支持原子提交、rebase/squash 工作流和历史搜索
- **harmony-dev** — HarmonyOS 开发全栈指南（ArkTS 语法、ArkUI 组件、状态管理和构建工具）
- **zn-frontend-dev** — 知鸟前端开发专用技能，用于管理端、移动端和 PC Web 应用开发
- **zn-plugin-dev** — 知鸟前端插件开发专用技能，用于插件系统插槽定制和调试

#### 工具与实用程序
- **xlsx** — 电子表格创建、编辑和分析工具，支持公式、格式化和数据可视化
- **web-lib-docs** — 知鸟内部前端库文档查询工具（zn-common、zn-admin-ui、zn-mobile-ui 等）
- **nova-extension-creator** — Nova CLI 扩展创建指南，包含模板、工作流和验证
- **skill-creator** — 技能创建工具，用于设计具有专业知识、工作流和工具集成的有效技能

### 🔌 Extensions (扩展)

功能强大的扩展包，包含多个技能和命令：

#### ⭐ 强烈推荐安装
- **task-with-files** — 将工作流程转换为使用持久的 markdown 文件进行规划、进度跟踪和知识存储，模仿 Manus AI（被 Meta 以 20 亿美元收购）的工作模式

#### 其他扩展
- **oh-my-nova** （开发中。。。）— Sisyphus 风格的任务管理系统，提供 9 个专业子代理（sisyphus、oracle、explore、deep、ultrabrain、artistry、quick、librarian、momus）用于协调复杂工作
- **agent-skills-extension** — 完整的 10 个专业技能集合，包括技能创建、文档查询、自定义命令、代理创建、扩展创建和 MCP 服务器构建器
- **config-setting-ext** — 配置扩展，启用开发工具并禁用使用统计以增强开发体验

---

## 🌟 强烈推荐：task-with-files

**为什么强烈推荐？**

`task-with-files` 扩展采用了 **Manus AI 工作模式**——这一工作流程让 Manus AI 被 Meta 以 **20 亿美元**收购。

### 核心优势

1. **持久化记忆** — 文件系统代替上下文窗口，防止信息丢失
2. **结构化规划** — 3 文件模式（task_plan.md, findings.md, progress.md）让工作井井有条
3. **进度可控** — 清晰的任务分解和进度追踪
4. **错误学习** — 所有错误和解决方案都被记录，避免重复犯错

### 适用场景

- ✅ 多步骤复杂任务（3+ 步骤）
- ✅ 需要深入研究和分析的任务
- ✅ 跨模块或多文件修改的任务
- ✅ 长期项目，需要持续跟踪进度

### 快速开始

```bash
# 安装扩展
zn-agent-plugin install --platform nova extensions task-with-files

# 开始一个新任务
/planning:start build-api

# 查看任务状态
/planning:status

# 恢复之前的任务
/planning:resume

# 完成任务
/planning:complete
```

### 工作流程示例

```
1. /planning:start build-api
   → 创建任务目录和 3 个规划文件

2. 编辑 task_plan.md，定义阶段和任务
   → Phase 1: 需求分析
   → Phase 2: 实现
   → Phase 3: 测试

3. 执行任务，更新进度
   → 标记完成的任务
   → 记录发现到 findings.md
   → 更新 progress.md

4. /planning:complete
   → 验证完成并生成总结
```

---

## 🎯 强烈推荐：planning-with-files Skill

**为什么强烈推荐？**

`planning-with-files` 技能与 `task-with-files` 扩展完美配合，是处理复杂任务的终极工具。

### 核心能力

1. **2-Action 规则** — 每进行 2 次读取/搜索操作，就更新 findings.md，防止上下文溢出
2. **自适应规划** — 发现新信息时动态调整计划
3. **决策记录** — 所有技术决策都有清晰的理由记录
4. **错误处理** - 永不重复相同的错误 3 次

### 典型使用场景

- "帮我实现一个用户认证系统"
- "重构整个支付模块"
- "调研竞品并生成报告"
- "搭建新的微服务架构"

### 使用建议

```bash
# 安装技能
zn-agent-plugin install skills planning-with-files --platform nova

# 在任务中自然使用（会自动激活）
"我需要实现一个 REST API 后端"
→ 自动激活 planning-with-files 技能
→ 引导你使用 3 文件模式规划任务
```

---

## 📚 资源仓库地址

- **代码仓库**: https://code.paic.com.cn/#/repo/git/zn-agent-assets/master/tree
- **文档**: https://code.paic.com.cn/#/repo/git/zn-agent-assets/master/blob/README.md

---

## 🤝 参与共建

欢迎为 zn-agent-assets 贡献资源！

### 贡献方式

1. **添加新的 Agent**
   - 在 `assets/agents/` 下创建 `<agent-name>.md`
   - 参考现有 agent 配置格式
   - 提交 Pull Request

2. **添加新的 Command**
   - 在 `assets/commands/` 下创建 `<command-name>.toml`
   - 参考 commit.toml 配置格式
   - 添加相应的 `.md` 文档文件
   - 提交 Pull Request

3. **添加新的 Skill**
   - 在 `assets/skills/` 下创建 `<skill-name>/` 目录
   - 包含 `SKILL.md` 主文档
   - 添加必要的脚本和资源
   - 提交 Pull Request

4. **添加新的 Extension**
   - 在 `assets/extensions/` 下创建 `<extension-name>/` 目录
   - 包含 `gemini-extension.json` 清单文件
   - 添加 README.md 文档
   - 提交 Pull Request

### 贡献指南

```bash
# Fork 仓库
git clone https://code.paic.com.cn/your-username/zn-agent-assets.git

# 创建特性分支
git checkout -b feature/my-new-skill

# 添加你的资源
# ...

# 提交更改
git commit -m "feat: add my-new-skill for XYZ"

# 推送到你的 fork
git push origin feature/my-new-skill

# 创建 Pull Request
```

---

## 📄 许可证

MIT License — 自由使用、修改和分发。

---

## 🆘 获取帮助

如果遇到安装或使用问题：

1. 查看 [代码仓库](https://code.paic.com.cn/#/repo/git/zn-agent-assets/master/tree) 搜索相关问题
2. 创建 Issue 或联系维护者提供详细的错误信息
3. 加入我们的社区讨论

---

**让 AI 成为你的最强大工，从安装第一个资源开始！** 🚀
