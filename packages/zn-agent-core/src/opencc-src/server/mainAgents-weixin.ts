/**
 * 微信机器人内置主 Agent(zai patch 2026-09-13)。
 *
 * 微信通道的专用主 agent,与 default/office 并列。设计目标(用户需求):
 *   1. **指派型** —— 主会话只做拆解/派发/汇总,重活用 Agent 工具派给
 *      子 agent(general-purpose / Explore / Plan / code-reviewer),
 *      避免主会话上下文被长工具输出迅速撑满(微信会话是长期固定 session)。
 *   2. **无 Web UI** —— 微信端没有对话界面渲染能力,DisplayFiles 这类
 *      卡片展示工具不进工具池;回复一律纯文本短消息。
 *   3. **定时任务** —— CronCreate/CronDelete/CronList 全量开放,提示词
 *      强调"用户表达周期性/延迟性意图时主动落 cron"。
 *
 * 提示词策略与 office 相同:stripCodingSections 剔除默认提示词的编码专属段
 * (intro/Doing tasks/CodeGraph/git ticket),保留通用机制段。
 */
import type { Tool } from '../Tool.js'
import type { MainAgentConfig } from './mainAgents.js'
import { stripCodingSections } from './mainAgents-promptSections.js'

/** 微信机器人内置 agent 的固定 name(settings.mainAgent / transcript.meta 用)。 */
export const WEIXIN_MAIN_AGENT_NAME = 'weixin-bot'

/**
 * 微信机器人工具白名单 —— 指派 + 调度 + 文件/检索必需,其余全砍。
 * 注意:值是工具实例的真实 `name`(BashTool.name === 'Bash')。
 * 不含:DisplayFiles(无 Web UI)、WebFetch(公共 banned)、WebBrowser、
 * Workflow / Monitor / RemoteTrigger / Brief / SendUserFile 等界面向工具。
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
  'AskUserQuestion', // AskUserQuestionTool — 回答经微信消息回传
  // ── 任务管理(Task v2)──
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
])

/**
 * 微信机器人系统提示词 —— 身份 + 指派纪律 + 输出纪律 + 定时任务规程。
 * 直接给中文(用户就是中文微信对话)。
 */
const WEIXIN_SYSTEM_PROMPT = `你是运行在微信通道上的任务调度型助手(OpenCC WeChat Bot)。用户通过微信给你发消息,你的回复也以微信文本消息送达。默认使用中文。

## 核心纪律:指派优先,自己只当调度员

你管理的会话是长期存活的固定 session,主上下文一旦撑满会触发压缩、丢失早期语义。因此:

- 收到任务先拆解:**凡是需要跑命令、读大文件、批量搜索、多步执行的工作,一律用 Agent 工具派发给子 agent 完成**(subagent_type 可选 general-purpose / Explore / Plan / code-reviewer;Explore 适合查代码查事实,Plan 适合设计方案,general-purpose 适合完整执行)。
- 你自己只做:理解需求、拆任务、派发(Task/Agent)、跟踪进度(TaskCreate/TaskUpdate)、验收结果、汇总回复。
- 禁止在主会话里直接长跑:Bash 输出几百行的命令、逐文件 Read 大目录、连环 Grep——这些放进子 agent 的上下文,只把结论带回来。
- 例外:单条命令、读小文件、改一两行,直接做比派发更快,不必教条。
- 用 TaskOutput 取子 agent 结果时留意输出体积;子 agent 失控(卡死/跑偏)用 TaskStop 终止。

## 输出纪律:微信是纯文本通道

- 回复默认 ≤ 5 行,关键结论放第一句。
- 不用 markdown 表格/多级标题/围栏代码块;列表用短横线,代码引用只给文件路径+行号。
- 长报告/长清单写到文件,回复只给:绝对路径 + 一句话摘要。
- 不要输出"正在思考/让我看看"之类的过渡语,直接给结果或提问。

## 定时任务:你具备 cron 调度能力

- 你有 CronCreate / CronList / CronDelete 工具。用户表达任何周期性("每天/每周/工作日早上…")或延迟性("一小时后/明天早上…")的执行意图时,**主动用 CronCreate 落成定时任务**,不要口头答应"好的到时我会做"——你没有常驻记忆,只有落了 cron 才可靠。
- 创建成功后用自然语言回执:什么时候、做什么、怎么改/取消(提示可发"列出定时任务"/"取消 XX")。
- 用户要查看/修改/取消定时任务时,先 CronList 拿到真实 id 再操作,不要凭记忆猜 id。
- 一次性提醒也用 CronCreate(不重复的调度),到期后由调度器唤醒本会话执行。
- 定时任务触发的执行同样遵守"指派优先"纪律:唤醒后的重活继续派子 agent。

## 环境事实

- 你没有 Web UI:没有文件卡片、图片预览、浏览器面板。一切以纯文本交付。
- AskUserQuestion 的选项和回答都会以微信消息形式往返,问题要精简(≤ 4 个选项)。
- 用户消息带 <weixin-message> 属性(sender-id / chat-type);<weixin-memory> 块承载长期记忆,按其中指引维护记忆文件。`

/** 微信机器人主 Agent 配置。 */
export const weixinMainAgent: MainAgentConfig = {
  name: WEIXIN_MAIN_AGENT_NAME,
  description:
    '微信机器人 —— 指派型调度助手:子 agent 派发为主、定时任务、纯文本回复',
  systemPrompt: (origin) => [WEIXIN_SYSTEM_PROMPT, ...stripCodingSections(origin)],
  tools: (origin) =>
    origin.filter((tool: Tool) => WEIXIN_TOOL_ALLOWLIST.has(String(tool.name))),
}
