# zn-agent-assets

AI Agent 配置资源库，包含 Nova CLI 的 agent 配置、命令定义、技能模块及发布工具。

## 项目结构

```
zn-agent-assets/
├── assets/                    # 资源配置目录
│   ├── agents/               # Agent 配置
│   │   └── code-review-agent.md
│   ├── commands/             # 命令配置
│   │   └── commit.toml
│   └── skills/               # 技能模块
│       ├── doc-coauthoring/  # 文档协作技能
│       ├── docx/             # DOCX 文档处理技能
│       ├── pdf/              # PDF 处理技能
│       └── skill-creator/    # 技能创建工具
├── packages/                  # 功能包
│   └── publisher/            # 资源发布工具
├── README.md
└── .gitignore
```

## 快速开始

### 1. 安装依赖

```bash
cd packages/publisher
npm install
```

### 2. 使用配置

#### Agent 配置
将 `assets/agents/` 下的配置文件添加到 Nova CLI 的 agents 目录。

#### 命令配置
将 `assets/commands/` 下的配置文件添加到 Nova CLI 的 commands 目录。

#### 技能模块
将 `assets/skills/` 下的技能目录添加到 Nova CLI 的 skills 目录。

## 可用资源

### Agents

| Agent | 描述 |
|-------|------|
| [code-review-agent](assets/agents/code-review-agent.md) | 代码审查 Agent |

### Commands

| 命令 | 描述 |
|------|------|
| [commit](assets/commands/commit.toml) | 自动生成提交信息并提交代码 |

### Skills

| 技能 | 描述 |
|------|------|
| [doc-coauthoring](assets/skills/doc-coauthoring/SKILL.md) | 文档协作技能（引导用户完成文档协作创作流程） |
| [docx](assets/skills/docx/SKILL.md) | DOCX 文档处理工具包（评论管理、OOXML 解析、验证等） |
| [git-master](assets/skills/git-master/SKILL.md) | Git 操作专家技能（原子提交、rebase、历史搜索等） |
| [harmony-dev](assets/skills/harmony-dev/SKILL.md) | HarmonyOS 开发技能（ArkTS 和 ArkUI 开发） |
| [mcp-builder](assets/skills/mcp-builder/SKILL.md) | MCP (Model Context Protocol) 服务器创建工具 |
| [nova-extension-creator](assets/skills/nova-extension-creator/SKILL.md) | Nova CLI 扩展创建工具 |
| [pdf](assets/skills/pdf/SKILL.md) | PDF 处理工具包（提取、创建、合并、分割、表单处理等） |
| [planning-with-files](assets/skills/planning-with-files/SKILL.md) | 基于文件的规划技能（3 文件模式：task_plan.md, findings.md, progress.md） |
| [pptx](assets/skills/pptx/SKILL.md) | PPTX 演示文稿创建、编辑和分析工具 |
| [skill-creator](assets/skills/skill-creator/SKILL.md) | 技能创建工具 |
| [slack-gif-creator](assets/skills/slack-gif-creator/SKILL.md) | Slack GIF 创建工具（动画优化） |
| [web-lib-docs](assets/skills/web-lib-docs/SKILL.md) | 知鸟内部前端库文档查询工具 |
| [webapp-testing](assets/skills/webapp-testing/SKILL.md) | Web 应用测试工具包（Playwright 集成） |
| [xlsx](assets/skills/xlsx/SKILL.md) | 电子表格创建、编辑和分析工具 |
| [zn-frontend-dev](assets/skills/zn-frontend-dev/SKILL.md) | 知鸟前端开发专用技能 |
| [zn-plugin-dev](assets/skills/zn-plugin-dev/SKILL.md) | 知鸟前端插件开发专用技能 |

## 开发

### 发布新资源

```bash
cd packages/publisher
npm run publish <resource-type> <resource-path>
```

### 添加新 Agent

1. 在 `assets/agents/` 下创建 `<agent-name>.md`
2. 参考现有 agent 配置格式
3. 更新 README.md

### 添加新命令

1. 在 `assets/commands/` 下创建 `<command-name>.toml`
2. 参考 commit.toml 配置格式
3. 更新 README.md

### 添加新技能

1. 在 `assets/skills/` 下创建 `<skill-name>/` 目录
2. 包含 `SKILL.md` 主文档
3. 添加 `scripts/` 目录存放脚本
4. 更新 README.md

## 许可证

MIT
