# @zn-ai/zai-agent-core 架构

## 分层

```
┌─────────────────────────────────────────────────────┐
│                   zai-server (B)                     │
│  Express routes → SSE → AgentRuntime.run()           │
└──────────────────────┬──────────────────────────────┘
                       │ import
┌──────────────────────▼──────────────────────────────┐
│              zai-agent-core (A)                      │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  src/runtime/                                │   │
│  │  query() / abortSession() / DefaultRuntime   │   │
│  │  streamAdapter / RuntimeEvent                │   │
│  └───────────────┬──────────────────────────────┘   │
│  ┌───────────────▼──────────────────────────────┐   │
│  │  src/opencc-internals/                       │   │
│  │  OpenCC 核心模块 (CV + TUI 剔除)               │   │
│  │  query / QueryEngine / Tool / tools          │   │
│  │  services/api/ / services/mcp/ / skills/     │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │  src/transcript/                             │   │
│  │  TranscriptStore ~/.zai/transcripts/          │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │  src/data/                                   │   │
│  │  dataDir 解析 (ZAI_DATA_DIR / ~/.zai)          │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## 数据流

```
User prompt → query() ──→ OpenCC query() → StreamEvent
                │                           │
                ├── transcriptStore.append   │
                └── wrapWithZaiMeta ─────────┘
                              │
                    RuntimeEvent ——→ wire SSE → Browser
                    (RuntimeErrorEvent / RuntimeDoneEvent / RuntimeAbortedEvent)
```

## 关键决策

- 不读 OpenCC `settings.json`，zai 独立 `~/.zai/settings.json`
- 不抽 slash commands，web 走 UI dialog
- 所有错误走 RuntimeErrorEvent 流式事件
- transcript 用 JSON 文件（不是 JSONL），每 session 一个文件
- 并发安全用 proper-lockfile（不解决跨机器）
