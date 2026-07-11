# 贡献指南

欢迎贡献资源到 zn-agent-assets！

## 添加新资源

### 1. Agent 配置

位置: `assets/agents/<name>.md`

格式:
```markdown
# Agent Name

## Description

## Capabilities

## Usage
```

### 2. 命令配置

位置: `assets/commands/<name>.toml`

格式参考 [commit.toml](assets/commands/commit.toml)

### 3. 技能模块

位置: `assets/skills/<name>/`

必需文件:
- `SKILL.md` - 技能主文档（YAML frontmatter + Markdown 内容）

推荐结构:
```
assets/skills/<skill-name>/
├── SKILL.md              # 必需：技能主文档
├── references/           # 可选：参考文档、示例代码
├── scripts/             # 可选：辅助脚本（如 Node.js、Python）
├── templates/           # 可选：模板文件
├── assets/              # 可选：资源文件（图片、配置等）
└── README.md            # 可选：技能说明文档
```

#### SKILL.md 格式规范

技能文档必须以 YAML frontmatter 开头：

```markdown
---
name: skill-name
description: 简短描述技能的用途（1-2 句话）
---

# Skill Title

## 当使用此技能

[描述触发此技能的场景和条件]

## 核心功能

[技能的主要功能和能力]

## 使用指南

[详细的操作步骤和示例]

## 参考资料

[相关的文档链接或文件路径]
```

**Frontmatter 字段说明：**
- `name`: 技能名称（必填，kebab-case 格式）
- `description`: 技能描述（必填，简洁明了）

#### 技能开发最佳实践

1. **清晰的触发条件**：在 "当使用此技能" 部分明确说明何时激活此技能
2. **结构化内容**：使用 Markdown 标题、列表、代码块组织内容
3. **实用示例**：提供具体的使用示例和代码片段
4. **可复用资源**：将可复用的代码放入 `scripts/`，模板放入 `templates/`
5. **参考文档**：在 `references/` 中存放相关文档链接或详细说明

### 4. 扩展模块

位置: `assets/extensions/<name>/`

必需文件:
- `gemini-extension.json` - 扩展配置
- `AGENTS.md` - 扩展特定的 Agent 指令

## 提交规范

- 使用英文或中文均可，保持一致性
- Agent/命令/技能描述使用中文
- 代码注释使用英文
- 遵循 Conventional Commits 规范：
  - `feat:` 新功能
  - `fix:` 修复 bug
  - `docs:` 文档更新
  - `refactor:` 代码重构
  - `chore:` 构建/工具链相关
