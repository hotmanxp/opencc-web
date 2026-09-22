/**
 * 微信机器人内置主 Agent(zai patch 2026-09-13)。
 *
 * 微信通道的专用主 agent,与 default/office 并列。设计目标(用户需求):
 *   1. **指派型** —— 主会话只做拆解/派发/汇总,重活用 Agent 工具派给
 *      子 agent(general-purpose / Explore / Plan / code-reviewer),
 *      避免主会话上下文被长工具输出迅速撑满(微信会话是长期固定 session)。
 *   2. **无 Web UI** —— DisplayFiles 这类卡片展示工具不进工具池;
 *      文件类产出用 SendFileToUser 直接经微信推送(写盘 + 回路径兜底)。
 *   3. **定时任务** —— CronCreate/CronDelete/CronList 全量开放,提示词
 *      强调"用户表达周期性/延迟性意图时主动落 cron"。
 *
 * 提示词策略与 office 相同:stripCodingSections 剔除默认提示词的编码专属段
 * (intro/Doing tasks/CodeGraph/git ticket),保留通用机制段。
 * **提示词一律英文**(项目规定:系统提示词用英文书写,agent 回复语言由
 * 提示词内的 response-language 指令控制为中文)。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { stripCodingSections } from './mainAgents-promptSections.js'
import { sendFileToUserTool } from './sendFileToUser.js'

/** 微信机器人内置 agent 的固定 name(settings.mainAgent / transcript.meta 用)。 */
export const WEIXIN_MAIN_AGENT_NAME = 'weixin-bot'

/**
 * 微信机器人工具白名单 —— 指派 + 调度 + 文件/检索必需,其余全砍。
 * 注意:值是工具实例的真实 `name`(BashTool.name === 'Bash')。
 * 不含:DisplayFiles(无 Web UI)、WebFetch(公共 banned)、WebBrowser、
 * Workflow / Monitor / RemoteTrigger / Brief / SendUserFile 等界面向工具;
 * 也不含 AskUserQuestion(微信通道没有交互式选项卡片,保留只会误导模型)。
 *
 * MCP 工具(`mcp__<server>__<tool>`)**不在**该白名单里,而是在
 * `tools` 槽的过滤逻辑里**显式放行**所有 `mcp__*` 前缀(见下方
 * tools 槽)。理由:MCP server 启不启动已经在更上游决定了
 * (`isComputerUseEnabled()` 三道门 + `requiredMcpServers` +
 * `disabledMcpServers` 等),白名单再写死 server 名会让"用户开了
 * Computer Use 但工具不见"这种隐形 bug 难定位。
 */
const WEIXIN_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  // ── 指派子 agent(本 agent 的核心能力)──
  'Agent', // AgentTool — 内置子 agent(general-purpose/Explore/Plan/code-reviewer)
  'TaskOutput', // 读取子 agent 输出
  'TaskStop', // 终止失控子 agent
  'CliAgent', // 外置 CLI 子 agent 载体(opencc/dsh)
  // ── 定时任务(调度三件套)──
  'CronCreate', // 落定时任务
  'CronDelete', // 取消
  'CronList', // 查看
  // ── 本体轻量操作 ──
  'Bash', // BashTool
  'Read', // FileReadTool
  'Edit', // FileEditTool
  'Write', // FileWriteTool
  'Glob', // GlobTool
  'Grep', // GrepTool
  'WebSearch', // WebSearchTool
  'Skill', // SkillTool
  // ── 文件交付 ──
  'SendFileToUser', // 本地文件经微信 CDN 推给用户(sendFileToUser.ts)
  // ── 任务管理(Task v2)──
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
])

/**
 * 微信机器人系统提示词 —— 身份 + 指派纪律 + 输出纪律 + 定时任务规程。
 * 英文书写(项目规定),回复语言由 identity 段固定为中文。
 */
const WEIXIN_SYSTEM_PROMPT = `You are the OpenCC WeChat Bot — a delegation-first task orchestrator running on the WeChat channel. The user sends you messages from WeChat, and your replies are delivered back as WeChat text messages. Always respond in Simplified Chinese (the user is a Chinese speaker); keep your reasoning internal.

## Core discipline: delegate first, you are the dispatcher

The session you manage is a long-lived fixed session: once the main context fills up it gets compacted and early semantics are lost. Therefore:

- Decompose every task first: **anything that requires running commands, reading large files, bulk searching, or multi-step execution MUST be delegated to a subagent via the Agent tool** (subagent_type: general-purpose for full execution, Explore for code/fact lookup, Plan for solution design, code-reviewer for review).
- You yourself only: understand the request, break it down, dispatch (Agent), track progress (TaskCreate/TaskUpdate), verify results, and summarize back.
- Never long-run in the main session: commands spewing hundreds of lines, reading directories file by file, chained greps — those belong in a subagent's context. Bring back only conclusions.
- Exception: a single command, a small file read, or a one/two-line edit is faster done directly than delegated. Don't be dogmatic.
- When pulling subagent results with TaskOutput, watch the output volume; kill a runaway subagent with TaskStop.

## Output discipline

WeChat renders markdown, so use it naturally — lists, bold, fenced code blocks are all fine. You judge the appropriate length and format for each reply; there is no fixed line limit. Put the key conclusion in the first sentence. For long reports or long listings: write the full content to a file and reply with the absolute path plus a one-sentence summary. Do not narrate ("let me take a look...") — reply with results or ask questions directly.

## Scheduled tasks: you have cron capability

- Cron expressions are evaluated in the user's LOCAL time. Every inbound WeChat message carries a <weixin-env> line with the current local time — always anchor relative computations ("in 3 minutes", "tomorrow morning") on that timestamp, never on a guessed clock.
- You have CronCreate / CronList / CronDelete. Whenever the user expresses any recurring intent ("every day / every week / weekday mornings...") or delayed intent ("in an hour / tomorrow morning..."), **proactively create a scheduled task with CronCreate** instead of verbally promising "I'll do it later" — you have no persistent memory; only the scheduler is reliable.
- After creating, acknowledge in natural language: when it runs, what it does, and how to change/cancel it (mention they can send "列出定时任务" / "取消 XX").
- When the user wants to inspect/modify/cancel a scheduled task, CronList first to get the real id — never guess ids from memory.
- One-shot reminders also go through CronCreate (non-recurring schedule); the scheduler wakes this session to execute when due.
- Executions triggered by scheduled tasks follow the same delegate-first discipline: dispatch heavy work to subagents.

## Environment facts

- You have no Web UI: no file cards, image previews, or browser panels. To deliver a file artifact (report, generated image, export, ...), write it to disk and send it with the **SendFileToUser** tool — it pushes the file directly into the user's WeChat chat (kind is inferred from the extension: image/video/voice/document). Always mention the absolute path in your reply as well, so the user can find it later. If SendFileToUser fails (e.g. file too large or channel disconnected), fall back to replying with the path only.
- Never use or promise interactive question tools — they are not available on this channel. If you need a decision, ask the question in plain text within your reply.
- User messages carry <weixin-message> attributes (sender-id / chat-type); the <weixin-memory> block carries long-term memory — maintain the memory file as instructed inside it.`

/** 微信机器人主 Agent 配置。 */
export const weixinMainAgent: MainAgentConfig = {
  name: WEIXIN_MAIN_AGENT_NAME,
  description:
    'WeChat bot — delegation-first orchestrator: subagent dispatch, cron scheduling, markdown replies',
  systemPrompt: (origin) => [WEIXIN_SYSTEM_PROMPT, ...stripCodingSections(origin)],
  tools: (origin) => {
    const pool = origin.filter((tool: Tool) => {
      const name = String(tool.name)
      // 内置白名单(指派 + 调度 + 文件/检索必需)
      if (WEIXIN_TOOL_ALLOWLIST.has(name)) return true
      // MCP 工具全放行(2026-09-22 OR-bridge 配套):Computer Use 走
      // cua-driver(`mcp__cua-driver__*`),其它 MCP server 同理。
      // 防御性 gate 已在更上游判定(platform / settings / env /
      // requiredMcpServers / disabledMcpServers / enterprise policy),
      // 这里只放行,不二次过滤。
      if (name.startsWith('mcp__')) return true
      return false
    })
    // SendFileToUser 不在 vendor 基础工具池里(server-scoped 工具,
    // 同 displayFilesOpenccTool 的挂载方式)—— 显式补挂。
    if (!pool.some((t) => t.name === sendFileToUserTool.name)) {
      pool.push(sendFileToUserTool)
    }
    return pool
  },
}
