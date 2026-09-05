# QuickCreateModal · 目录选择器 + 图片附件

> **Task Factory · 快速创建弹窗增强**(zai patch,2026-09-05)
>
> 在 `QuickCreateModal`(`packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx`)的表单里:
> 1. `cwd` 输入旁增加「选择目录」按钮,复用现有 `DirectoryPicker` 组件;
> 2. description 输入下方增加图片附件区,支持「选择图片」按钮与 Ctrl+V 黏贴;
> 3. 图片走「上传到磁盘 + 路径引用」送达 task-intake-quick(不依赖模型视觉能力);
> 4. 现有 `DirectoryPicker` 从 `pages/Instances.tsx` 抽到 `components/common/`,Instances.tsx 改 import。

## 1. 背景与现状

`QuickCreateModal` 是任务工厂「快速创建」弹窗(tf-429i39sy 2026-09-05 去掉 title 输入,只保留 description)。当前字段:`description`(必填)、`priority`、`cwd`(纯 `<Input>` 手动输入)、`agent`、`dependsOn`。

**问题**

- `cwd` 字段只能手敲绝对路径;复用 Instances 页已有的「选择工作目录」Modal(走 `/api/fs/picker`)能显著降低打错路径的概率。
- 描述常常需要带截图(按钮样式 / Bug 现场 / 设计稿);当前只能写到 description 文本里说"按 X 截图改文案",模型看不到截图。图片走"上传到磁盘 + @path 引用"是最稳的方案:不依赖模型视觉能力,跨子 agent(可能没有视觉)都能用 Read 工具读到。

**现有相关组件**

| 组件 | 位置 | 用途 |
|------|------|------|
| `DirectoryPicker`(私有,未 export) | `pages/Instances.tsx:147-317` | 走 `/api/fs/picker?path=...`,Modal + 主页/上级/刷新 + entry 列表 + 服务端路径规范化 |
| `PendingAttachment` / `readImageAsBase64` | `components/AgentInputBox.tsx`、`lib/imageReader.ts` | AgentInputBox 的图片附件状态 + base64 读取;`imageReader.ts` 校验 10MB 上限 + 支持 jpeg/png/gif/webp |
| `AttachmentStrip` | `components/AttachmentStrip.tsx` | AgentInputBox 用的缩略图条 |
| `/api/fs/upload` | 后端 routes | base64 + name → `<cwd>/.zai/uploads/<name>`,返回 `absPath` |
| `task-intake-quick` 主 agent | `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskIntakeQuick.ts` | 接收 quick-create 提交,工具白名单含 Read,可读上传后的图片 |

## 2. 目标

- 快速创建弹窗的 `cwd` 字段支持「选择目录」按钮,弹出现有 `DirectoryPicker` Modal。
- 描述区支持「选择图片」按钮与 Ctrl+V 黏贴截图。
- 提交时图片自动写到 `<cwd>/.zai/uploads/`,提交 prompt 文本补一段 `attachments: [...]` 清单,task-intake-quick 可用 Read 工具读取。
- `DirectoryPicker` 从 Instances.tsx 抽出到 `components/common/`,Instances.tsx 同步改 import,行为零变化。
- mobile drawer 形态(`mobileAsDrawer=true`)下,选择目录 / 添加图片 / 黏贴全部可用。
- 单测覆盖所有新增路径;`/ego-browser` 真实浏览器走完桌面 + 移动端两条路径。

## 3. 非目标(明确不做)

- **不做** 图片内联 `contentBlocks` 路径(/agent/prompt 附加 base64 块)——依赖模型视觉能力,跨模型不稳。
- **不做** 拖拽上传 —— 弹窗容器小,Modal 内拖拽区域难看出;按钮 + 黏贴已覆盖主流场景。
- **不做** 图片数量大于 8 —— `MAX_IMAGES_PER_QUICK = 8`;超过时截断 + message.warning。
- **不做** cwd 与图片上传路径的强一致性校验 —— task-intake-quick 用 Read 读绝对路径,与 cwd 字段解耦;与 AgentInputBox 拖非图片文件行为一致。
- **不做** 修改 task-intake-quick 的 systemPrompt —— 现有 Read 工具已能读图;`attachments:` 清单由 QuickCreateModal client 拼好再喂 prompt。
- **不做** 图片上传进度条 / 缩略图以外的预览交互 —— 与 AgentInputBox 一致,只显示缩略图 + 失败红字。

## 4. 架构与组件边界

### 4.1 新建/修改文件

| 路径 | 改动 | 估行数 |
|------|------|--------|
| **新建** `packages/zai/src/web/src/components/common/DirectoryPicker.tsx` | 把 `Instances.tsx:147-317` 的内联 `DirectoryPicker` 整体迁过来并 `export`,props 形状不变;`FsPickerEntry`/`FsPickerList` 类型同文件导出 | 175 |
| **新建** `packages/zai/src/web/src/components/common/DirectoryPicker.test.tsx` | 单测覆盖:打开 / fetch 成功失败 / 主页 / 上级 / 选中 / 取消 / 空目录 | 200 |
| **改** `packages/zai/src/web/src/pages/Instances.tsx` | 删内联 `DirectoryPicker`(约 170 行),从 `../components/common/DirectoryPicker` import;`FsPickerEntry`/`FsPickerList` 类型若 Instances 自己用了同步改 import | -170 |
| **新建** `packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.tsx` | 只读缩略图条:接收 `items: QuickAttachment[]`、`onRemove(id)`、`disabled?: boolean`;不依赖 AgentInputBox 的 store / 状态机 | 70 |
| **新建** `packages/zai/src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx` | 渲染空 / 多张 / status='error' 红字 / 点 × 调 onRemove | 60 |
| **改** `packages/zai/src/web/src/components/superTasks/QuickCreateModal.tsx` | 加 `attachments` state、`addImages`、`removeAttachment`、`handlePaste`、`uploadImage`、`cwdPickerOpen` state;cwd `<Input>` 后挂「选择目录」按钮 + `<DirectoryPicker>`;description `<Input.TextArea>` 加 `onPaste`;提交时 `Promise.all` 上传图片 + 路径塞进 `buildQuickPrompt` 输出;`canSubmit` 加 reading 阻断 + 全失败阻断 | +120 |
| **改** `packages/zai/src/web/src/components/superTasks/QuickCreateModal.test.tsx` | 新增 cwd picker / image attachments / mobile drawer 等 describe block(详见 §8) | +250 |

### 4.2 组件边界理由

- **`DirectoryPicker` 抽到 `common/`**:Instances 和 QuickCreateModal 共享同一份 picker 行为 + 测试;Instances 端改 import 是零行为变化的纯重构。
- **`QuickAttachmentStrip` 不复用 `AttachmentStrip`**:AgentInputBox 的 `AttachmentStrip` 接 `PendingAttachment` 形状不完全匹配(后者依赖 AgentInputBox 的 blob URL 生命周期策略),且耦合到 16 上限 / 缩略图大小策略。写一个 30-70 行的只读版本,只暴露 `items` / `onRemove` / `disabled`。

## 5. 数据流与提交流程

### 5.1 提交流程

```
[user] 点击「快速创建」
  ↓
[QuickCreateModal] canSubmit 校验
  (description 非空,!submitting,!hasReading,
   attachments.length===0 || readyCount>0)
  ↓
async handleSubmit():
1. readyPaths = await Promise.all(
     attachments.filter(a=>a.status==='ready')
                .map(uploadImage)   // 走 /api/fs/upload
   )
     - 失败项保留 status='error',不抛(其他继续)
     - 全部失败 → setError('所有图片上传失败...') + 阻断
  2. buildQuickPrompt({
     title, description, priority, cwd, agent, dependsOn,
     attachments: readyPaths,
   })
  3. api.post('/agent/prompt',
     { prompt, sessionId: sid },
     { headers: { 'X-Session-Id': sid } })
  4. 等 task_factory.created SSE → 完成条 + 「完成」按钮
     (现有逻辑不变)
```

### 5.2 buildQuickPrompt 新输出

现有 `lines: string[]` 末尾(在 `Pass mode: "quick"` 行**之前**)插入:

```
attachments (absolute paths, Read these if you need to see them):
- /Users/.../zai-project/.zai/uploads/screenshot.png
- /Users/.../zai-project/.zai/uploads/mock.png
```

注意:这一段在「Pass mode: 'quick'」**之前**插入,确保模型先看到附件清单,再被告知 quick 模式约束。

### 5.3 uploadImage(单步)

参考 `AgentInputBox.uploadFileToProject`,**只走图片分支**:

```ts
async function uploadImage(att: QuickAttachment): Promise<string> {
  const data = att.dataUrl.replace(/^data:[^;]+;base64,/, '')
  const res = await fetch('/api/fs/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: att.filename, data }),
  })
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  if (!body.absPath) throw new Error('上传响应缺少 absPath')
  return body.absPath
}
```

### 5.4 addImages(批量读取 base64)

参考 `AgentInputBox.addAttachments`:

```ts
async function addImages(files: File[]) {
  const accepted = files.slice(0, MAX_IMAGES_PER_QUICK)  // 8
  const placeholders = accepted.map(f => ({
    localId: genLocalId(),
    mime: f.type, size: f.size,
    filename: f.name || 'image.png',
    dataUrl: '', thumbnailUrl: URL.createObjectURL(f),
    status: 'reading' as const,
  }))
  setAttachments(prev => [...prev, ...placeholders])
  await Promise.all(placeholders.map(async (p, i) => {
    try {
      const r = await readImageAsBase64(accepted[i]!)
      setAttachments(prev => prev.map(a =>
        a.localId === p.localId
          ? { ...a, dataUrl: r.dataUrl, status: 'ready' }
          : a))
    } catch (e) {
      setAttachments(prev => prev.map(a =>
        a.localId === p.localId
          ? { ...a, status: 'error', error: e instanceof Error ? e.message : String(e) }
          : a))
    }
  }))
}
```

### 5.5 handlePaste(description TextArea)

```ts
function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
  const files: File[] = []
  for (const item of e.clipboardData.items) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f && f.type.startsWith('image/')) files.push(f)
    }
  }
  if (files.length === 0) return  // 走 antd 默认文本粘贴
  e.preventDefault()
  void addImages(files)
}
```

非图片文件(如 PDF):`f.type.startsWith('image/')` 过滤掉,**走 antd 默认黏贴行为**(不静默吞)。

### 5.6 canSubmit 升级

```ts
const hasReading = attachments.some(a => a.status === 'reading')
const readyCount = attachments.filter(a => a.status === 'ready').length
const hasAnyAttachment = attachments.length > 0
const canSubmit = description.trim().length > 0
  && !submitting
  && !hasReading                                            // 还在读 → 阻断
  && (!hasAnyAttachment || readyCount > 0)                  // 有附件但全失败 → 阻断
```

### 5.7 Mobile drawer 行为

所有 hooks / state / 行为零改动;`mobileAsDrawer=true` 走 `<Drawer>` 容器,缩略图条 / 选择目录按钮 / 黏贴在 drawer body 内同样工作。`handleContainerClose` 现有逻辑保持:created 状态下走 `handleDone`(含 deleteAgentSession),非 created 状态走 onClose。

## 6. 错误处理与边界

| 场景 | 行为 |
|------|------|
| 图片超 10MB(`imageReader` 内已校验) | `addImages` 标 `status='error'`,error="图片超过 10MB 上限" —— 缩略图条该卡片红字;`canSubmit` 在 `readyCount===0 && attachments.length>0` 时阻断 |
| 图片格式不支持(非 image/* 或非 jpeg/png/gif/webp) | 同上,`unsupported_mime` |
| `FileReader` 读取失败 | `ImageReadError('read_failed', ...)`,同上 status='error' |
| `/api/fs/upload` 失败(HTTP 4xx/5xx / 网络错) | 该 attachment `status='error'`,error 取 body.error;其它图片继续上传(并行) |
| 全部图片上传失败 | `setError('所有图片上传失败,请重试或移除')`,不调 `/agent/prompt`,UI 红条 |
| 部分上传失败 | 只把 ready 路径写进 prompt 文本;失败项保留 UI 状态,用户可点 × 移除后重新选择 |
| 上传进行中点提交 | `canSubmit = !hasReading` 阻断 |
| 上传后未立刻提交(用户继续编辑) | 缩略图条一直在,直到用户点 × 移除或提交成功后清空 |
| 同一张图重复黏贴 | `localId` 不同,出现两张缩略图;不主动去重 |
| 黏贴非图片文件(如 PDF) | handlePaste 过滤,走 antd 默认文本粘贴行为,**不静默吞** |
| 上传图片到磁盘后,用户改 cwd | 已上传图片仍带 absPath,**不发警告** —— 任务参数里的 cwd 与上传路径解耦(Read 支持绝对路径) |
| 关闭弹窗时 attachments 未清 | `useEffect` 在 `open` 切回 false 时清空 + `attachments.forEach(revokeObjectURL)` |
| mobile drawer 关闭手势 | 走 `handleContainerClose`(现有逻辑);非 created 状态触发 useEffect 清附件 |
| 目录选择器路径不存在 / 跨平台 | DirectoryPicker 现有逻辑:服务端规范化路径,客户端不转换;失败时 `picker-error` Alert,保留 currentPath 让用户点上级恢复 |
| 图片数量 > 8 | `slice(0, 8)` + `message.warning('最多 8 张图片,已截断')` |
| 缩略图 blob URL 泄漏 | useEffect unmount / open=false 时 `attachments.forEach(a => URL.revokeObjectURL(a.thumbnailUrl))` |

## 7. 测试用例

### 7.1 新 `DirectoryPicker.test.tsx`

- `open=true`:fetch `/api/fs/picker?path=<initialPath>` → 渲染 entries
- fetch 失败:`picker-error` Alert 渲染,currentPath 保留
- 空目录:`空目录`占位
- 点「主页」→ fetch `path=<home>`
- 点「上级」→ fetch `path=<parent>`
- 点 entry → fetch `path=<entry.path>`(递归下钻)
- 点「选择当前目录」→ 调 `onSelect(currentPath)` 并 `onCancel`
- 点「取消」→ 调 `onCancel` 不调 `onSelect`
- `open=false`:不发任何 fetch

### 7.2 `Instances.test.tsx`(若存在)

零改动 —— 行为由 `DirectoryPicker.test.tsx` 覆盖。

### 7.3 新 `QuickAttachmentStrip.test.tsx`

- 空数组:`暂无附件`占位(或仅空状态)
- 多张 ready:每张渲染缩略图 + 文件名 + × 按钮
- `status='error'`:error 文字红字显示
- 点 × → 调 `onRemove(localId)`

### 7.4 改 `QuickCreateModal.test.tsx`

**新增 describe `cwd picker`**:

- 「选择目录」按钮存在(`data-testid="quick-cwd-picker-trigger"`)
- 点击 → `data-testid="quick-directory-picker"` Modal 渲染
- picker 选中路径 → cwd 字段更新成服务端返回的 path
- picker 取消 → cwd 不变

**新增 describe `image attachments`**:

- 「添加图片」按钮存在(`data-testid="quick-image-picker-trigger"`)
- 点击 → 触发隐藏 input.click(用 `vi.spyOn(inputRef.current.click)`)
- `addImages` mock fetch `/api/fs/upload` → ready 状态渲染缩略图条
- description `onPaste`:DataTransfer 含 image/png 文件 → 调 `addImages`
- description `onPaste`:DataTransfer 不含文件 → 文本不阻断
- 黏贴非 image/* 文件 → 不调 `addImages`
- 超 8 张 → slice + `message.warning`
- 超 10MB → status='error' 卡片
- 全部 ready 提交 → fetch `/agent/prompt` 含 `attachments:\n- /abs/path/1.png`
- 部分失败(一条 ok 一条 fail)→ prompt 只含 ok 路径,fail 项仍可点 ×
- 全部失败 → 不发 `/agent/prompt`,显示错误 Alert
- 还在 reading → `canSubmit=false`(按钮 disabled)
- 关闭弹窗 → attachments 清空

**新增 describe `mobileAsDrawer`**:

- `mobileAsDrawer=true`:选择目录按钮同样触发 picker(Drawer 内嵌 Modal 不出栈)
- `mobileAsDrawer=true`:黏贴图片同样工作

### 7.5 手动验证(`/ego-browser`)

- 起 `pnpm --filter @zn-ai/zai dev -- --port <空闲端口>`,访问 `/super-tasks`,打开快速创建 Modal
- 测试 cwd picker:点「选择目录」→ DirectoryPicker Modal 弹出 → 选 home / 选子目录 → cwd 字段更新 → 关闭 picker
- 测试图片按钮:点「添加图片」→ 文件选择 → 看到缩略图条 → 提交后 prompt 含上传路径
- 测试图片黏贴:在 description 框里 Cmd+V 一张截图 → 看到缩略图条
- 测试错误处理:选 11MB 图片 → 缩略图红字 + 按钮 disabled;黏贴 PDF → 文本不消失
- 测试部分失败:mock upload 一条 ok 一条 fail → 提交后只含 ok 路径
- 测试完成流程:提交成功 → SSE 创建 → 完成条出现 → 点完成关闭
- 切到 `/m`:drawer 模式同样走一遍

## 8. 实现要点与注意事项

- **不要内联 base64**:走磁盘 + 引用,与跨模型稳定性匹配;不与 AgentInputBox 的 contentBlocks 路径耦合。
- **DirectoryPicker 抽出后**:Instances.tsx 改 import 是纯改名,行为零变化;Instances 的现有测试(如存在)无需改动。
- **MAX_IMAGES_PER_QUICK = 8**:常量放在 QuickCreateModal.tsx 顶部,与 `QUICK_TITLE_MAX_LEN = 50`、`DEFAULT_QUICK_PRIORITY = 'P2'` 等并列。
- **`quick-cwd-picker-trigger` / `quick-directory-picker` / `quick-image-picker-trigger` / `quick-attachment-strip`** 是新增的 `data-testid`,便于测试。
- **组件命名**:缩略图条叫 `QuickAttachmentStrip`(`superTasks/` 私有,不复用 AgentInputBox 的 AttachmentStrip);目录选择器复用 `DirectoryPicker`(`common/`,跨域共享)。
- **`genLocalId`**:复用 AgentInputBox 的兜底实现(`crypto.randomUUID` + `att-` 时间戳随机数),不引入新工具函数。
- **`buildQuickPrompt` 顺序**:保持现有 lines 顺序,只在 `Pass mode: 'quick'` 行**之前**插入 attachments 块,确保模型先看到附件清单,再被告知 quick 模式约束。
- **`/agent/prompt` header**:`{ headers: { 'X-Session-Id': sid } }` 与现有契约一致,不引入新 header。

## 9. 兼容性

- 桌面(`width=640`)与移动端(`Drawer placement="bottom" height="90%"`)两条路径均完整支持。
- fullscreen 模式(`fullscreen=true`)同样支持(描述下方缩略图条 + cwd picker 按钮正常渲染)。
- 现有任务:`QuickCreateModal` 的核心契约(`buildQuickPrompt` 输出含 `mode: "quick"`、`task-intake-quick` 主 agent、`createAgentSession` 走同一 API)零变化。
- Instances.tsx:DirectoryPicker import 路径从内联改为 `../components/common/DirectoryPicker`,API 完全一致。

## 10. 验收清单(完成定义)

- [ ] `DirectoryPicker` 抽到 `components/common/`,Instances.tsx 改 import,Instances 行为零变化
- [ ] `DirectoryPicker.test.tsx` 覆盖 §7.1 所有用例
- [ ] `QuickAttachmentStrip` 渲染正确 / 失败红字 / × 删除
- [ ] `QuickCreateModal` cwd 字段有「选择目录」按钮 → 打开 picker → 选中回填
- [ ] `QuickCreateModal` description 下方有「添加图片」按钮 + 缩略图条 + 黏贴监听
- [ ] 提交时图片走 `/api/fs/upload` → 路径塞进 `buildQuickPrompt` 输出(在 `Pass mode: "quick"` 行之前)
- [ ] 部分失败 / 全部失败 / 还在 reading 三种状态按 §6 处理
- [ ] `mobileAsDrawer=true` 下所有交互同样工作
- [ ] 关闭弹窗时 attachments 清空 + blob URL revoke
- [ ] `pnpm --filter @zn-ai/zai test src/web/src/components/common/DirectoryPicker.test.tsx src/web/src/components/superTasks/QuickCreateModal.test.tsx src/web/src/components/superTasks/QuickAttachmentStrip.test.tsx` 全绿
- [ ] `/ego-browser` 真实浏览器走完桌面 + 移动端两条路径(必做)

## 11. 相关文档

- `docs/superpowers/specs/2026-09-01-task-factory-design.md` —— Task Factory 总体设计
- `docs/superpowers/specs/2026-09-04-task-factory-quick-intake-design.md` —— quick-intake 模式
- `packages/zai/src/web/src/pages/Instances.tsx:147-317` —— DirectoryPicker 当前实现
- `packages/zai/src/web/src/components/AgentInputBox.tsx:735-824` —— addAttachments / handlePaste 参考
- `packages/zai/src/web/src/lib/imageReader.ts` —— readImageAsBase64 + 10MB 校验
- `packages/zn-agent-core/src/opencc-src/server/mainAgents-taskIntakeQuick.ts` —— task-intake-quick 主 agent(systemPrompt + 工具白名单)