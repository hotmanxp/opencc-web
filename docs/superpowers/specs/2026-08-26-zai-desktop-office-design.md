# Spec — zai desktop:AI 驱动的办公桌面环境

**Status**: draft(设计已确认,实现待启动)
**Implements**: 在 zai 中新增 `/desktop` 全屏沉浸式"仿 macOS"办公桌面:壁纸 + Dock + 可拖拽浮窗(资源管理器窗 + Agent 对话窗),资源拖入附件区作为 `@` 文件引用上下文,Agent 默认 Office
**Code (current)**: `packages/zai/src/web/src/pages/Agent.tsx`、`AgentConversation.tsx`、`components/AgentInputBox.tsx`、`components/AttachmentStrip.tsx`、`components/Layout.tsx`、`router.tsx`、`server/routes/fsPicker.ts`
**Code (proposed)**: `packages/zai/src/web/src/pages/Desktop.tsx` + `components/desktop/`(新增);`packages/zai/src/server/routes/desktopFs.ts`(新增)
**Companion plan**: `docs/superpowers/plans/2026-08-26-zai-desktop-office-plan.md`(待生成)

## Problem

zai 现有交互是工具型页面:左侧 Sider 菜单在 `Agent / 实例管理 / 登录 / 管理` 间切换,对话区与文件资源彼此分离。用户需要一个**以 AI 为底层驱动的办公环境**:视觉上是操作系统桌面(壁纸、Dock、浮窗),资源(本地文件、未来线上资源)与 AI 对话直接打通——把文件拖进对话附件即作为 Agent 上下文(`@path` 文件引用),Agent 固定使用 Office 模式。

现状能力盘点:

| 能力 | 现状 |
|---|---|
| 菜单 + 路由 | `Layout.tsx` `ALL_MENU_ITEMS` + `router.tsx`;页面均在 `Layout`(Sider 150px)内 |
| 对话引擎 | `AgentConversation`(会话侧栏 + 消息列表 + 输入框),内部含 `AgentInputBox`(dsh 式输入,`@` 文件引用 chip,MentionChip) |
| 文件引用上下文 | `mentionGrammar.formatFileMention`:把选中路径格式化为 `@path` / `@"path with spaces"` 文本,随 prompt 提交,Agent 凭路径用 FS 工具读文件 |
| 图片附件 | `AgentInputBox` 的 `PendingAttachment`(base64 瞬态,`AttachmentStrip` 渲染缩略图)—— 与本设计**不混用** |
| 本地文件 API | `routes/fsPicker.ts`(`/api/fs/picker`,任意绝对路径、仅列**目录**);`routes/fs.ts`(`/api/fs`,列文件+目录但 `resolveSafePath` 锁死 cwd 内) |
| Office Agent | `WorkMode = 'code' \| 'office' \| 'general'`;`SettingsDrawer.tsx:1108` 已有 `workMode==='office' && mainAgent==='default'` → 自动 PUT `main-agent=office` 的联动 |
| 会话流式 | `App.tsx` 全局挂 `useEventStream`(不依赖 Layout),desktop 内可正常收流 |
| 主题 | `useEffectiveTheme` + `<html data-theme>`,可复用 |

## Decision

**新增 `/desktop` 全屏沉浸式页面,脱离 `Layout`(无 Sider),作为独立 Route 接入 `router.tsx` 顶层。** 桌面 = 壁纸层 + 图标区(快捷方式)+ 顶栏 + Dock + 两个初始浮窗(资源管理器、Agent 对话)。浮窗是自研轻量窗口系统(`DesktopWindow`),不引入 electron-window 类重依赖。

核心设计取舍:

1. **复用而非重写**:Agent 窗直接渲染现有 `AgentConversation`,会话数据/store/SSE 全局共享——`/desktop` 里聊的会话在 `/agent` 同样可见,反之亦然。
2. **文件上下文走 `@mention` 通道**:附件区是"文件引用 chip 条",发送时把未在 draft 中的路径以 `mentionGrammar` 语法 append 进 prompt 文本。不引入内容快照、不加新的 prompt 参数,Agent(office,带 FS 工具)按路径实时读文件。
3. **资源浏览放开到任意路径**:新增服务端端点(见 §4.2),安全模型与 `fsPicker` 一致——zai 仅监听 localhost,等同本机 `ls`。
4. **Office 仅桌面作用域**:进入 `/desktop` snapshot 原 `workMode/mainAgent` → 持久化切到 office;离开还原。不污染用户原有设置。
5. **轻窗口系统扁平化**:窗口位置/大小/最小化/最大化存 `localStorage`;不做多实例窗口、不做窗口状态机持久化之外的能力。
6. **YAGNI**:首版不做线上资源实际接入(仅空态 Tab);不做 office/PDF 在线预览(文件双击仅支持图片/TXT 内嵌预览,其余提示待接入);不做窗口自由拖放定位(快捷方式网格流式布局)。

### 不在范围

- 线上资源(网盘/团队资源)真实接入 —— 预留 Tab + 空态,API 形态后续另立 spec
- Office/PDF/WPS 在线预览 —— 双击文件仅图片/TXT 走 `/api/fs/file` 内嵌预览
- 替换现有 `/agent` —— 桌面与工具页平行并存,均为顶层入口
- 移动端 `/m` —— 桌面仅 PC 端,`useIsMobile` 为 true 时 URL 访问 `/desktop` 重定向 `/agent`(后续可再议)
- 完整 macOS 仿真(Launchpad、聚焦搜索、多 Space)—— 本设计只取壁纸 + Dock + 浮窗 + 图标四个表象

## 架构

```
router.tsx 顶层独立 Route(不进 Layout)
  /desktop → pages/Desktop.tsx
              ├─ 壁纸层(预设 / 上传 dataURL,localStorage: desktop.wallpaper)
              ├─ 图标区(快捷方式网格,localStorage: desktop.shortcuts)
              ├─ 便签层(StickyNotes,壁纸层之上/窗口层之下,localStorage: desktop.notes)
              ├─ 顶栏(时钟 / 主题切换 / 壁纸设置 / 退出桌面)
              ├─ 待办面板(TodoPanel,Dock「待办」开合,右侧浮出,localStorage: desktop.todos)
              ├─ Dock(Agent · 资源管理器 · 壁纸设置 · 便签 · 待办 · 退出;激活放大)
              └─ DesktopWindow 窗口管理器(localStorage: desktop.windows)
                    ├─ Window: 资源管理器(DesktopExplorer)
                    │     ├─ Tab 本地 / 线上(空态)
                    │     └─ 文件网格 ← GET /api/desktop/fs/list?path=<abs>
                    └─ Window: Agent 对话
                          ├─ AgentConversation(复用)
                          └─ AttachmentZone(附件区,drop → FileRef chip)
                                └─ 发送: gatherMentions(attachments, draft)
                                     → mentionGrammar.formatFileMention → prompt

server/routes/desktopFs.ts(新增)
  GET  /api/desktop/fs/list?path=<absolute> → { path, parent, entries:[{name,kind,size,mtime,preview}] }
  GET  /api/desktop/fs/file?path=<abs>      → { ok, mime, dataUrl }(文本/图片 ≤2MB)
  POST /api/desktop/open  body { path }     → { ok }(调系统默认应用打开非预览文件)
```

数据流(拖文件 → AI 上下文):

```
资源窗文件项 draggable ──dataTransfer{path,name,kind}──▶ 附件区 drop
                                                        → FileRef chip(图片来源: formatFileMention)
发送 prompt:
  [未含该路径] append `@path` / `@"path with spaces"` 到 draft 末尾(空格分隔)
  → POST /agent/prompt → Office Agent 收到 prompt 含文件引用
  → Agent 用 FS 工具按路径读取文件内容作为工作上下文
```

## 详细设计

### 4.1 路由与外壳

- `router.tsx` 顶层新增 `<Route path="/desktop" element={<Desktop />} />`,**不包 Layout**;fallback `*` 仍指向 `/agent`
- `Layout.tsx` `ALL_MENU_ITEMS` 增加 `{ key: '/desktop', icon: <DesktopOutlined/>, label: '桌面' }` 作为唯一进入入口;桌面内顶栏左侧提供"退出桌面"返回 `/agent`
- `Desktop` 挂载时若 `useAppStore.isMobile` → `navigate('/agent', { replace: true })`
- 全局 `SettingsDrawer`/`UpdateNotifier` 依赖 Layout 层挂载,desktop 内自带一个 `settingsDrawerOpen` 的本地唤起(顶栏设置图标),复用 `SettingsDrawer` 组件本身(可独立 `<SettingsDrawer/>` 挂载在 Desktop 内,组件自管理开关 props 来自 appStore,现状即 appStore 全局字段,直接复用)

### 4.2 资源管理器窗(DesktopExplorer)

**服务端 — `server/routes/desktopFs.ts`(新增)**

```
GET /api/desktop/fs/list?path=<absolute-path>
  参数:path = '' 或缺省 → os.homedir();非空 → expandTilde + path.resolve + normalize
  响应:
    { ok:true, path, parent: string|null(根为 null), entries:[
        { name, kind:'file'|'dir', size, mtime } ] }   // 按 dir 在前、名称字典序
  错误(ok:false + 4xx/5xx 文案,复用 fsPicker 的 errorBody 模式):
    NUL 字节 → 400;ENOENT → 404;EACCES/EPERM → 403;stat/readdir 其它 → 500
  细节:不隐藏点文件;symlink 不解析真实路径(stat 不 follow);列 file+dir(与 fsPicker 只列 dir 不同)
```

设计依据:复用 fsPicker 的"任意路径 + localhost 安全模型 + 错误映射",把 readdir 从『仅目录』扩为『文件+目录』,服务端改动 ~60 行;不动 `routes/fs.ts`(其 cwd 锁是 agent 文件工具的安全边界,勿污染)。

**前端 — DesktopExplorer**

- 顶部 Tab:`本地` / `线上`(线上为空态卡片,"线上资源 · 待接入",预留 `desktop.onlineSources` 类型与后续 API 插槽)
- 导航:面包屑(当前位置)+「上级」按钮(parent 为 null 时禁用)+ 路径输入(手输直达,回车跳转)+ 书签(Home/桌面/当前项目 cwd,来自 `/system`)
- 主区:文件网格(`fileIcon` 复用 `components/splitPane/fileIcon` 的扩展名→图标映射),单击选中(高亮),双击:dir → 进入;file → 触发预览(见 §4.3.2)
- 加载态:首次 loading;错误态:窗内 Alert(404/403 文案)+ 自动回退上级

### 4.3 Agent 对话窗 + 附件区

#### 4.3.1 窗体内复用 AgentConversation

直接渲染 `<AgentConversation/>`,窗口内 `overflow:auto`,小窗可滚动;最大化时等同 `/agent` 会话体。会话侧栏折叠态默认收起(`sessionsCollapsed` 初值 true),腾出窗口宽度。SSE/事件流全局,无需额外接线。

#### 4.3.2 附件区(AttachmentZone)

- 位置:Agent 窗顶部(会话侧栏右侧、消息列表之上)一条可折叠 strip
- 组成:FileRef chip(`MentionChip` 样式:文件名 + 完整绝对路径,可移除 X),上限 **16**
- 拖放:仅接受 `dataTransfer.types` 含 `application/x-zai-file`(资源窗拖出自定义 MIME,type 内嵌 JSON `{path,name,kind}`);来源非资源窗的 drop `preventDefault` + 忽略(不做浏览器文件上传——拖入浏览器的文件拿不到系统路径,没有引用价值;与 `/api/fs` 的 `.zai/uploads` 副本机制无关,那是拖盘外文件的兜底,本设计不做)
- 发送:纯函数 `gatherMentions(attachments, draft): string`——对每个 chip:路径若已以 `@` mention 形式出现在 draft 中则跳过,否则 `formatFileMention({path,kind:'file'}, false)`;空格拼接(首位加 `\n`);结果 append 到 draft 末尾后走现有 `submitPrompt`。`formatFileMention` 遇控制字符/双引号返回 undefined → 该 chip 打 `invalid` 标记并跳过
- 绝对路径 mention:`@/Users/foo/a.md` 无空格 → 原生语法;含空格 → `@"..."` 引号变体,均为 `activeAtToken` 已支持的形态

#### 4.3.3 文件预览与系统打开(双击)

**「支持预览」以服务端白名单为唯一真相源**:`GET /api/desktop/fs/list` 在每条 entry 上带 `preview: boolean`(文本/图片扩展名 → true),前端**不做扩展名镜**

像、不发探测请求,直接按 `entry.preview` 分流:

- `preview === true`(文本/图片,白名单同本端点 file 的 mime 判定)→ 双击新建轻预览浮窗(300x400),请求 `GET /api/desktop/fs/file?path=<abs>`(服务端解码限 2MB,仅放行文本/图片 mime,返回 `{ok, mime, dataUrl}`)
- 否则(其余类型)→ `POST /api/desktop/open` body `{path}` 调**系统默认应用打开**:macOS `open -- <path>`、Windows `cmd /c start "" "<path>"`(spawn 不用 shell,路径作为独立参数无注入面)、Linux `xdg-open <path>`;成功 toast「已用系统默认应用打开:<文件名>」

> 不在前端用 `api.get('/desktop/fs/file')` 失败后回退:该客户端对非 2xx 会触发全局 `notifyApiError` 通知,预期失败不该弹错误条。故判型走 list 的 `preview` 标志。

> `/api/desktop/fs/file` 是**新端点**:不能复用 `/api/fs/file`——后者受 `resolveSafePath` 锁死在 cwd 内,与资源区"任意路径"矛盾。

### 4.4 桌面壳细节

- **壁纸**(`useLocalStorageState('desktop.wallpaper')`):默认内置多张 CSS 渐变 + 2 张内置渐变图;上传:FileReader → dataURL,`image/*` 白名单校验,fail 拒绝 toast;设置入口在顶栏与 Dock,**壁纸设置唤起的是一块独立轻面板(Popover,不占 DesktopWindow 槽位)**
- **顶栏**:左侧 时钟(时:分,秒级不必要)+ 主题切换(复用 `handleToggleTheme` 同款 PUT)+ 退出桌面;右侧 壁纸设置 + 设置齿轮(唤起 SettingsDrawer)
- **Dock** 图标:Agent、资源管理器、壁纸设置、便签、待办、退出桌面(左起);hover 放大动画(transform scale 1.15,过渡 120ms);激活窗对应图标加发光点
- **快捷方式**(`useLocalStorageState('desktop.shortcuts')`):数组 `{id,name,path,kind}`;从资源窗拖到壁纸空白(drop on desktop layer,非窗口)创建;网格流式布局(72px 图标 + 12px 文本);单击选中、双击 → dir 有资源窗打开则导航至该目录(无则打开资源窗直达)/file 触发预览;右键 → 小菜单(移除、在资源管理器定位)

### 4.5 窗口系统(DesktopWindow)

- 状态:`useLocalStorageState('desktop.windows')`,形如:
  ```ts
  { id:'explorer'|'agent', title, x, y, w, h, z, minimized, maximized }
  ```
- 交互:
  - 标题栏(红黄绿圆点 + 标题):Pointer Events 拖拽移动(`setPointerCapture`),拖动中钳制在桌面边界内;双击标题栏 → 最大化/还原
  - 右下角 resize handle:Pointer Events 缩放,最小 w/h 320x200;`agent` 窗最小 560x420(会话可用性)
  - 点击窗体内任意处 → zIndex 置顶(递增)
  - 最小化 → 隐藏 + Dock 图标高亮;Dock 点击 → 还原/前置
- 初始布局:explorer 左(x 24,y 24,w 420,h 60%),agent 右(x 470,y 24,余宽,h 60%);进入桌面时从 localStorage 恢复,缺失用默认

### 4.6 Office 作用域(仅桌面)

挂载流程(`Desktop.tsx` useEffect,幂等):

```
0. /desktop 脱离 Layout,store 未被 Layout hydrate —— 先自取 GET /api/agent/settings 读磁盘 workMode/mainAgent
1. snapshot:localStorage 'desktop.settings.snapshot' = { workMode, mainAgent }
2. 若 workMode!=='office' → PUT /api/agent/settings/work-mode office
3. 若 mainAgent!=='office' → PUT /api/agent/settings/main-agent office
4. 同步 setWorkMode('office') / setMainAgent('office')(store 即时生效)
卸载流程(cleanup):
5. 读 snapshot,若存在 → PUT 还原 workMode/mainAgent;清 snapshot
```

- 桌面内无 workMode/mainAgent 切换 UI("暂不支持切换"天然成立)
- 切流中的会话不受影响(Agent 在 prompt 发送时确定)
- PUT 失败(网络异常)静默,`console.warn`,不阻塞桌面渲染;下次进入重试
- 会话数据本身不因 mainAgent 切换丢失(设置是"默认 Agent",历史 transcript 原样)

### 4.7 便签与待办(新增 2026-08-26)

- **便签(StickyNotes)**:壁纸层之上、窗口层之下的绝对定位便签纸卡片(`zai.desktop.notes`,数组 `{id,text,x,y,color}`)
  - Dock「便签」点击新建(160x120 卡片 + 26px 头部,位置取视口中部 + 级联偏移,id 前端唯一);头部可拖拽移动(指针钳制视口内);正文 textarea 直接编辑;右上角 X 删除;空态不渲染层
  - 便签层 `pointer-events:none` 仅卡片可交互 —— 不拦截窗口/壁纸区域
- **待办(TodoPanel)**:Dock「待办」开合的右侧浮出面板(`zai.desktop.todos`,数组 `{id,text,done}`)
  - 输入 + Enter/加号添加;Checkbox 勾选 → 删除线;单条 X 删除;面板 X 关闭;空列表「暂无待办」
- 均经 `useLocalStorageState` 持久化(函数型 updater 已由共享 hook 修复支持)

### 4.8 错误处理汇总

| 场景 | 处理 |
|---|---|
| 资源列表 ENOENT/EACCES/其它 | 窗内 Alert + 回退上级;不 toast |
| path 解析异常(resolve 后不存在 / 非目录) | 404 / 400,窗内提示,不清空输入 |
| 拖入非资源窗载荷 | drop 忽略(`preventDefault`) |
| 附件超 16 | 拒绝 + toast「附件最多 16 个」 |
| mention 含控制字符/双引号 | chip `invalid` 标记,发送跳过 |
| 壁纸上传非图片 | toast 拒绝 |
| Office PUT 失败 | 静默 + console.warn,下次进入重试 |
| localStorage 损坏(JSON parse 失败) | `useLocalStorageState` 兼容,回退默认 |

## 改造点概览

| 文件 | 改动 |
|---|---|
| `packages/zai/src/web/src/router.tsx` | 顶层新增 `/desktop` Route(不进 Layout) |
| `packages/zai/src/web/src/components/Layout.tsx` | `ALL_MENU_ITEMS` 加"桌面"项 |
| `packages/zai/src/web/src/pages/Desktop.tsx` | 新增:页面骨架(壁纸/顶栏/Dock/窗口挂载/Office 作用域) |
| `packages/zai/src/web/src/components/desktop/DesktopWindow.tsx` | 新增:浮窗(拖拽/缩放/最小化/最大化/置顶) |
| `packages/zai/src/web/src/components/desktop/DesktopExplorer.tsx` | 新增:资源管理器(Tab/导航/文件网格) |
| `packages/zai/src/web/src/components/desktop/AttachmentZone.tsx` | 新增:附件区 strip(FileRef chip) |
| `packages/zai/src/web/src/components/desktop/desktopStore.ts` | 新增:窗口/快捷方式/壁纸状态(useLocalStorageState 组合) |
| `packages/zai/src/web/src/components/desktop/gatherMentions.ts` | 新增:纯函数(附件→prompt mention 文本) |
| `packages/zai/src/server/routes/desktopFs.ts` | 新增:`GET /api/desktop/fs/list` + `GET /api/desktop/fs/file`(预览,文本/图片,2MB 上限) |
| `packages/zai/src/server/index.ts` | 挂载 desktopFs 路由 |

## 测试(只跑受影响文件,遵循 AGENTS.md 粒度)

| 文件 | 覆盖 |
|---|---|
| `test/web/components/desktop/Desktop.test.tsx` | 窗口开/关/置顶/最小化/最大化、localStorage 持久化恢复、Office 作用域(挂载 PUT / 卸载还原,fetch mock) |
| `test/web/components/desktop/gatherMentions.test.ts` | 去重(draft 已含)、空格路径 `@"..."`、控制字符跳过、上限、空附件 |
| `test/server/routes/desktopFs.test.ts` | list:目录+文件混合排序、ENOENT→404、EACCES→403、NUL→400、path 缺省→home、parent 根为 null;file:图片/文本 ok、超 2MB→413、非白名单→400 |
| 样式改动 | 不跑单测(壁纸/Dock/窗口视觉),完成前 `/ego-browser` 真实验收 |

**真实验收(强制,`/ego-browser`)**:`/desktop` 壁纸与 Dock 渲染、浮窗拖拽/缩放/置顶、资源窗双击导航、拖文件到附件区、发送后会话内出现 `@path`(Agent 可见)、返回 `/agent` 后 workMode/mainAgent 还原、`/agent` 与 `/desktop` 会话互通。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `AgentConversation` 在小窗内布局退化(会话侧栏 140px + 输入框) | agent 窗最小 560x420;会话侧栏默认折叠;必要时对该窗下调 `sessionsCollapsed` |
| 绝对路径 `@/abs/path` 的 Agent 语义 | 与 `/api/fs` 同 cwd 的 UPLOADS 副本机制不同;实现时用真实 office agent 冒烟测一条绝对路径 mention,不通过则 fallback 到打开 `/agent` 输入已含路径 |
| 拖拽实现粗糙(Pointer Events) | 首版 demo 级:不追求贴磁/自动吸附;窗口边界钳制必须有 |
| localStorage 旧版本损坏 | `useLocalStorageState` 已有容错,回退默认 |
| 与未来线上资源冲突 | 资源源类型建模 `{type:'local'|'online', path, ...}`,API 形态留到线上资源 spec |
| React 18 StrictMode 双跑 effect | Office 作用域 effect 需幂等(重复 snapshot/PUT 无副作用,uuid snapshot key) |

## Out of scope

- 线上资源真实接入(占位 Tab)
- Office/PDF/WPS 预览
- 桌面多 Space / Launchpad / 全局搜索
- 移动端适配
- `/agent` 与 `/desktop` 合并或替换