# Bug 发掘报告 · opencc

**参赛者**：`opencc`
**日期**：2026-10-16
**基准提交**：`6f9ceaeb`（`main`）

---

## 一、取证环境

- 工作树状态（收口前 `git status --porcelain` 输出）：

  ```
  ?? docs/bugs/bug-hunt-game-10-16/
  ```

  与 §1 判定口径一致：只有本比赛目录非空。**收口前我再次核对过（见文末「自证」小节），HEAD 未变、树未被污染。**

- typecheck 基线结果（§3.3）：

  ```
  zai  exit = 0   错误数 = 0
  core exit = 0   错误数 = 0
  ```

  - 已知基线：两个包都是 **exit 0，零预存错误**（README §3.4）
  - 我的基线与已知基线的差异：**无**。`/tmp/bughunt-opencc/tc-core.log` 末行与裁判 §3.4 抄录的完全一致：
    `[verify-server-types] OK — 5 d.ts file(s) in dist/opencc-src/server/ are self-contained`
  - **因此本报告不含任何 typecheck 证据**：两条 bug 都是运行时行为缺陷，类型系统看不见（正如 §3.4 所说「typecheck 绿不代表没有 bug」）。我没有为了凑一条「typecheck 红」而去制造静态矛盾。

- 我实际执行过的命令（关键项）：

  ```bash
  # 基线
  git rev-parse HEAD                    # 6f9ceaeb7c9bf63e71f4deea9346f790a107ea14
  git status --porcelain                # 仅 ?? docs/bugs/bug-hunt-game-10-16/
  pnpm --filter @zn-ai/zai run typecheck          > /tmp/bughunt-opencc/tc-zai.log  2>&1; echo exit=$?   # 0
  pnpm --filter @zn-ai/zn-agent-core run typecheck > /tmp/bughunt-opencc/tc-core.log 2>&1; echo exit=$?   # 0

  # 起隔离实例（换端口 + 隔离数据目录）
  lsof -i :8101 / :7715                 # 均为空 = 空闲；9201 是用户实例，全程未碰
  ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home ZAI_WEIXIN_OWNER_LOCK_DIR=/tmp/bughunt-opencc/zai-home/weixin-locks \
    pnpm --filter @zn-ai/zai dev -- --port 8101 --api-port 7715 > /tmp/bughunt-opencc/dev.log 2>&1 &

  # 打真实端点（详见各条 bug 的「复现命令与输出」）
  curl -s http://127.0.0.1:7715/api/health
  curl -s http://127.0.0.1:7715/api/agent/settings
  curl -s -X PUT  http://127.0.0.1:7715/api/desktop/wallpaper ...
  curl -s -X POST http://127.0.0.1:7715/api/git ...
  curl -s -X POST http://127.0.0.1:7715/api/terminal/create ...
  ```

- **数据隔离自证**（铁律 10）：

  ```bash
  # 我起的实例（唯一触碰数据目录的服务）
  ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home ZAI_WEIXIN_OWNER_LOCK_DIR=/tmp/bughunt-opencc/zai-home/weixin-locks \
    pnpm --filter @zn-ai/zai dev -- --port 8101 --api-port 7715
  ```

  隔离生效的证据（实例跑起来后 `find`）：

  ```
  /tmp/bughunt-opencc/zai-home/projects/-Users-ethan-code-opencc-web-packages-zai/sess-...jsonl
  /tmp/bughunt-opencc/zai-home/desktop/wallpapers/wmvb4dnl8-9bsjqj.png
  ```

  **重要声明（自曝从轻，不隐瞒）**：在追 oc-001 的过程中，我**发现**了这个隔离漏洞本身。也就是说，
  我的实例虽然名义上传了 `ZAI_DATA_DIR`，但 `settings.json` 这条路径**没有**被隔离。
  我因此**立即停止了所有会写 settings 的探测**（详见该条的「对照组」小节），改为**只读 GET** 取证，
  并在收口前核对 `~/.zai/settings.json` 的 mtime 仍为 `Oct 16 22:50:23`（早于我本次会话）——
  **我没有对用户真实 settings.json 造成任何写入**。这条恰恰就是 bug 本身的性质。

- **端口自证**（铁律 11）：我起过的服务用的端口是 **8101（web）/ 7715（api）**，`lsof` 确认结果：

  ```
  $ lsof -nP -iTCP:7715 -sTCP:LISTEN
  node    75407 ethan   24u  IPv4  0xa44c4d90c8b73a61  0t0  TCP 127.0.0.1:7715 (LISTEN)
  ```

  **9201 未被 kill、未被占用、未被连接**——我只在 `lsof` 里**看过**它（确认是用户实例），
  之后所有请求一律打 7715。

---

## 二、排查范围

| 子系统 | 是否排查 | 结论 |
|---|---|---|
| `packages/zai/src/server/routes/` | ✅ 重点 | 产出 oc-001 / oc-002；git / terminal / exec / approve / answer / tasks / v2Tasks / fs / desktopFs / desktopWallpaper / sessionState 均通读并实测 |
| `packages/zai/src/server/services/` | ✅ 重点 | 产出 oc-001 / oc-003；settingsCache / zaiSettingsStore / instanceStore / atomicWrite / eventBus / sse / gitService / spawner / repl / terminal / restartCoordinator / historyArchive / aaClient(terminal, noticeStore, eventAdapter, reverseDispatch) 均通读 |
| `packages/zai/src/web/`（前端组件 / store / hooks） | ⚠️ 部分 | 只读 `useEventStream.ts` + 追 `WallpaperUploadField.tsx` / `Desktop.tsx` 的壁纸消费路径（为 oc-002 追调用方）。**未做组件树渲染**，故本报告无 E3b 前端条目 |
| `packages/zn-agent-core/src/compat/` | ⚠️ 部分 | 读 `messageQueueAdapter.ts`、`createReplSession.ts` 的 elicitation 接线、`dangling-shims/` 清单。**委托了一个子 agent 深挖，它运行约 40 分钟未返回任何结果，已终止**（见「放弃理由」） |
| `packages/zn-agent-core/src/agents/` `tools/` `commands/` | ❌ | 时间预算用尽；且 22 条已知缺陷主要就落在这片（vendor-write-symlink-bypass 等） |
| `packages/zn-agent-core/src/opencc-src/`（vendor） | ❌ | 未挖。§3.4 明确 vendor 照常计分，但我把时间花在了更有把握的一手代码上——**这是我本次的短板，见第六节** |
| 其他：`zn-agent-core/src/compat/` 下的 subprocess / bashTracker | ❌ | 子 agent 未返回，未自查 |

**我读过但明确放弃的区域**：

| 区域 | 放弃理由 |
|---|---|
| `docs/bugs/` 已列的 22 条 | 已知清单，重报 0 分。全部读��� `README.md` 避坑，**没有一条进正式报告** |
| vendor 被 stub 的 230 个 `.tsx`（§3.2 第 5 条） | 组件体已替换为 `return null`，不是缺陷 |
| `fs.ts` 的 `/fs/preview`、`/fs/raw`（:1190/:1336）、`/fs/file` PUT（:548）、`/fs/delete`（:1516） | 正是 `dns-rebinding-no-host-check` 与 `symlink-traversal-write-delete` 的行号，**主动绕开**。我只读了它们来做 oc-002 的对照（这是加分，不是重报） |
| `/api/exec` CSRF RCE | `exec-csrf-rce` 已知。我读了 `spawner.ts` 确认 `spawn` 不走 shell，无二次注入，**不报** |
| `abortAll` / `askRegistry` / `approveRegistry` / `permissionRegistry` 的跨会话串号 | `prompt-close-aborts-all-sessions` 已知，且源码里 `sessionId` 过滤**已经加上了**（`askRegistry.ts:84`、`approveRegistry.ts:111`、`permissionRegistry.ts:102`），`agentRuntime.ts:981-983` 调用点也确实传了 sid。**已修复的 bug 不报** |
| `SSE seq / 断点续传`、`sse-subscriber-and-session-leak`、`weixin-*` 全部条目 | 已知清单 |

**为什么没排查其它区域**：时间预算集中投入在「能起真服务打真端点、拿到 E3b 证据」的路径上。
我判断**一条经得起裁判逐行复核的 S1/E3b 胜过十条我来不及实证的 E1**（§10 的告警）。
我确实低估了 vendor（55 万行）的时间成本，这是本次的主要遗憾。

---

## 三、Bug 报告

### [oc-001] 设 `ZAI_DATA_DIR` 启动的隔离实例，仍读写用户真实的 `~/.zai/settings.json`

- **严重度**：**S1**（理由：数据损坏 + 越权。`ZAI_DATA_DIR` 是本仓库唯一的实例隔离机制，也是比赛铁律 10 的依托。
  被绕过意味着：(a) 任何「跑一个隔离实例 / 跑测试 / 起第二个 zai」的动作会**覆盖用户生产配置的 settings.json**——
  这正是 §2 铁律 10 所说「写坏它不是污染工作区，是毁用户数据」的同款后果；
  (b) 反向也成立——用户改过的 `outputStyle` / `maxVisibleMessages` / `autoDreamEnabled` 等**用户态配置被测试实例读走**，
  构成跨实例状态污染；(c) 更具体的伤害：`zaiMigration.ts:172` 用 `if (process.env.ZAI_DATA_DIR)` 决定是否跳过迁移，
  但真正落盘的路径不认这个变量，**「跳过迁移」与「写到别处」这两个决定互相矛盾**。
  属 S1 的「静默丢用户工作 / 数据损坏」一档。）

- **证据等级**：**E3b**（理由：起隔离实例 + 打真实 HTTP 端点 + 断言真实响应体内容。
  这是「HTTP 缺陷 = 起隔离实例打真实端点」的标准形态，满足 §4.2 的 E3b 判定。）

- **执行环境**：运行时 **Node v25.6.0**（`ps` 实测 `node/25.6.0`，产品运行时）· 测试工具链：无（用 curl 打真端点）· 平台 darwin-arm64
  - 为什么这个环境代表用户：**这就是产品自己的 dev 路径**。`packages/zai` 的 `dev` script 就是
    `tsx --loader ./node_modules/@zn-ai/zn-agent-core/dist/compat/runtime/bun-protocol.mjs src/cli/index.ts dev`
    （见 §3.1 与 `dev.log` 首行）。不是 mock、不是替身、不是 vendor CLI。
    说明一处与 §4.2 的模板差异：**README §1 写「实测 v22.22.3」，而本机当前默认 node 是 v25.6.0**。
    该差异不影响结论——本 bug 是纯 JS 路径拼接（`join(homedir(), …)`），与 Node 大版本无关。

- **位置**：
  - `packages/zai/src/server/services/zaiSettingsStore.ts:35-37`（**根因**）
    ```ts
    export function zaiSettingsPath(): string {
      return join(homedir(), '.zai', 'settings.json')
    }
    ```
  - `packages/zai/src/server/services/zaiSettingsStore.ts:23`（读）
    `const raw = await readFile(zaiSettingsPath(), 'utf-8')`
  - `packages/zai/src/server/services/zaiSettingsStore.ts:87` + `:89`（写）
    ```ts
    const path = zaiSettingsPath()
    await atomicWriteFile(path, JSON.stringify(settings, null, 2))
    ```
  - `packages/zai/src/server/services/zaiSettingsCache.ts:6`（import 了这个 helper），
    `:153` / `:176` 经由它间接读写
  - 对照组（同仓、写法正确）：`packages/zai/src/server/routes/desktopWallpaper.ts:38-40`、
    `packages/zai/src/server/services/factorySettings.ts:87`、`packages/zai/src/server/services/instanceStore.ts:33-35`
    —— 三处都写成 `join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), …)`

- **触发路径**：
  `ZAI_DATA_DIR=/tmp/x pnpm --filter @zn-ai/zai dev` → `createApp()` (`packages/zai/src/server/index.ts`) →
  `initZaiSettingsCache()` (`zaiSettingsCache.ts:187`) → `runInit()` (`:149`) → `tryReadSettings(zaiSettingsPath())` (`:153`) →
  **`zaiSettingsPath()` (`zaiSettingsStore.ts:35-37`) 丢掉 `ZAI_DATA_DIR`，返回真实 `~/.zai/settings.json`** →
  `cached = settings` (`:180`) → 任意后续 `GET /api/agent/settings`
  (`routes/agentSettings.ts:135`) 把**用户真实配置**发给隔离实例的客户端。

- **现象**：预期 —— 设了 `ZAI_DATA_DIR` 的实例，其 settings 读写应完全落在该目录下（`paths.ts:23`
  的 `ZAI_DIR` 就是这个约定的正例）。实际 —— 隔离实例读到并回吐用户**真实** `~/.zai/settings.json` 的内容；
  反向写也会覆盖真实文件。

- **影响**：
  - 对用户：`~/code` 下开一个「试试看的 zai 实例」、跑一次 vitest（`test/setup.isolation.ts:20` 正是
    设 `ZAI_DATA_DIR` 的地方）都可能把用户的 `outputStyle` / `permissions` / `mainAgent` 等
    **改写成测试值且不可恢复**。用户唯一的 `~/.zai/settings.json` 被隔离进程覆盖 = 生产 agent 配置丢失。
  - 对数据：`permissions.defaultMode` 默认为 `bypassPermissions`（`zaiSettingsCache.ts:73`）。
    若隔离实例以默认值回写，会把用户的收紧配置**冲掉**，后续所有 turn 静默放宽权限——这是权限判定被静默改写。
  - 对成本：settings 里含 `env`（真实文件里就有 `env` 键），隔离实例可读到用户注入的 API key 配置。

- **对照组**（E3 必填，见 §4.7）：

  - **对照组是什么**：**同一个进程、同一次请求**下，两条路径的对比——
    (A) 实验组 = `zaiSettingsPath()` 解析出的路径（`~/.zai/settings.json`）；
    (B) 对照组 = 同一实例内**正确遵守 `ZAI_DATA_DIR`** 的路径（transcript / wallpaper 落盘）。
    再叠加一个**内容对照**：把实例回吐的值与用户真实文件逐键比对。

  - **对照组输出**：

    ```
    $ curl -s -m 15 http://127.0.0.1:7715/api/agent/settings -o get-settings.json -w "HTTP=%{http_code}\n"
    HTTP=200
      outputStyle            real(~/.zai)=compact                served-by-isolated-instance=compact
      maxVisibleMessages     real(~/.zai)=30                     served-by-isolated-instance=30
      autoDreamEnabled       real(~/.zai)=True                   served-by-isolated-instance=True
      defaultSplitScreen     real(~/.zai)=True                   served-by-isolated-instance=True

    # 逐叶键机器比对（排除「恰好都是默认值」的巧合）
    shared leaf keys: 10, differing: 0        <-- 10 个键全部与真实文件一致，0 个不同
    ```

    对照组（同实例内遵守 `ZAI_DATA_DIR` 的落盘路径）：

    ```
    $ find /tmp/bughunt-opencc/zai-home -type f
    /tmp/bughunt-opencc/zai-home/projects/-Users-.../sess-1792163921317-nvuv53vc.jsonl
    /tmp/bughunt-opencc/zai-home/desktop/wallpapers/wmvb4dnl8-9bsjqj.png
    ```

    对照组代码（同仓、正确写法，grep 实测）：

    ```
    desktopWallpaper.ts:39: return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'desktop', 'wallpapers');
    factorySettings.ts:87:   return join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'factory-settings.json')
    instanceStore.ts:34:     return dataDir ?? process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
    ```

  - **它为什么有区分力**：`outputStyle=compact`、`maxVisibleMessages=30`、`autoDreamEnabled=True`
    是**用户态配置**，不可能是 `BUILTIN_DEFAULT_SETTINGS` 的产物——
    若读的是隔离目录/默认值，这些键会缺失或取默认值，机器比对就会显示 `differing > 0`。
    实测 `differing: 0` 且 10 个键全中，**排除了「巧合」与「读的是内置默认」两种替代解释**。
    而同实例内 transcript/wallpaper 正确落到 `/tmp`，证明「变量确实生效了、只是这一处漏了」——
    这排除了「`ZAI_DATA_DIR` 根本没传进去」这一竞争假设。两条对照合起来，把根因钉死在 `zaiSettingsPath()`。

  - **状态复位**：本探针**只做 GET**。发现该 bug 后我立即停止一切写 settings 的探测。
  `~/.zai/settings.json` 的 mtime 在收口前复核为 `Oct 16 22:50:23`（**早于本次会话**），
  且全程未调用任何 settings PUT/POST 端点。模块级单例（`zaiSettingsCache` 的 `cached`/`initPromise`）
  在本复现中**完全未被触碰**——我用的是真 HTTP 端点而非进程内 import，不存在 LRU/单例污染。

- **复现步骤**：
  1. `mkdir -p /tmp/bughunt-opencc/zai-home`
  2. `ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home pnpm --filter @zn-ai/zai dev -- --port 8101 --api-port 7715 &`
  3. `curl -s http://127.0.0.1:7715/api/agent/settings`
  4. 与 `~/.zai/settings.json` 逐键比对 → 完全一致
  5. 反向验证：`find /tmp/bughunt-opencc/zai-home -type f` → 只有 transcript/wallpaper，**没有 settings.json**

- **复现命令与输出**：

  ```bash
  # 1) 起隔离实例
  ZAI_DATA_DIR=/tmp/bughunt-opencc/zai-home ZAI_WEIXIN_OWNER_LOCK_DIR=/tmp/bughunt-opencc/zai-home/weixin-locks \
    pnpm --filter @zn-ai/zai dev -- --port 8101 --api-port 7715 > /tmp/bughunt-opencc/dev.log 2>&1 &

  # 2) 确认隔离目录里没有任何 settings
  $ find /tmp/bughunt-opencc/zai-home -name "settings*.json"
  (无输出)

  # 3) 打真实端点
  $ curl -s -m 15 http://127.0.0.1:7715/api/agent/settings -o /tmp/bughunt-opencc/get-settings.json -w "HTTP=%{http_code}\n"
  HTTP=200

  # 4) 与用户真实文件机器比对
  $ python3 -c "
import json
real=json.load(open('/Users/ethan/.zai/settings.json')); api=json.load(open('/tmp/bughunt-opencc/get-settings.json'))
def flat(d,p=''):
    o={}
    for k,v in (d or {}).items():
        kk=f'{p}.{k}' if p else k
        o.update(flat(v,kk)) if isinstance(v,dict) else o.__setitem__(kk,v)
    return o
r,a=flat(real),flat(api); s=[k for k in r if k in a]
print('shared:',len(s),'differing:',len([k for k in s if r[k]!=a[k]]))"
  shared: 10 differing: 0
  ```

- **同类未隔离路径清单**（同一次 grep 实测，供修复时一次收口，不必只补 settings 一处）：

  | 文件:行 | 解析出的路径 | 是否漏 `ZAI_DATA_DIR` |
  |---|---|---|
  | `zaiSettingsStore.ts:36` | `~/.zai/settings.json` | ❌ **漏** |
  | `fileStore.ts:13-14` | `~/.zai/settings.json` | ❌ **漏**（同一文件，两个 key） |
  | `fileStore.ts:119` | `~/.zai/AGENTS.md` | ❌ **漏** |
  | `commands/fileStore.ts:9` | `~/.zai/commands` | ❌ **漏** |
  | `mcpConfig.ts:135, 208` | `~/.zai/settings.local.json` | ❌ **漏** |
  | `mainAgents.ts:24` | `~/.zai/main-agents` | ❌ **漏** |
  | `manifest.ts:6` | `~/.zai`（`MANIFEST_DIR`） | ❌ **漏** |
  | `historyArchive.ts:33` | `~/.zai/task-factory` | ⚠️ 有 `ZAI_TASK_FACTORY_DIR` 独立开关，但**不认 `ZAI_DATA_DIR`** |
  | `paths.ts:61/98`、`factorySettings.ts:87`、`desktopWallpaper.ts:39`、`weixinMemory.ts:53`、`instanceStore.ts:34` | — | ✅ 已正确隔离（对照组正例） |

- **修复方案**：改 `packages/zai/src/server/services/zaiSettingsStore.ts:35-37` 的 `zaiSettingsPath()`，
  把 `join(homedir(), '.zai', 'settings.json')` 改为
  `join(process.env.ZAI_DATA_DIR || join(homedir(), '.zai'), 'settings.json')`——
  与同文件同层 `paths.ts:23` 的 `ZAI_DIR` 以及 `factorySettings.ts:87` 的既有写法保持一致。
  副作用注意：改完之后**大量现有测试会开始真的写临时目录而不是用户目录**——
  `test/setup.isolation.ts:20` 已经设了 `ZAI_DATA_DIR`，所以方向上是「让测试终于隔离」，
  但 `zaiSettingsStore.test.ts` / `instanceStore.test.ts` 等断言硬编码路径的用例可能需要复核。
  **建议同时**把上表 8 处一并改掉，否则只修 settings 会留下同类窟窿。
  **更根本的建议**：抽一个 `resolveZaiDir(dataDir?)` helper（等价于 `instanceStore.ts:33-35`），
  从此禁止在 `services/` 与 `routes/` 里再出现裸 `join(homedir(), '.zai')`。

- **上游对照**（选填，加分项）：本条全在 `packages/zai` 一手代码内，`opencc-src/` 无对应位置，**不适用**。

---

### [oc-002] 壁纸端点回吐带脚本的 SVG 且无 `nosniff`/`CSP`，而仓库自己在 `/fs/raw` 上已识别并加固了同一威胁

- **严重度**：**S2**（理由：本机已存 XSS → 同源脚本执行 → 可调本机 API。
  我**没有**报 S1，因为存在一个真实的减损事实（见下「影响」与「自我否定清单」第 1 条）：
  正常 UI 路径把壁纸当 **CSS background** 用，浏览器对 `background-image` 里的 SVG **不执行脚本**；
  触发需要用户**直接导航**到该 URL。定 S2 而非 S3 的理由是：一旦导航发生，
  在生产模式下该 URL 与 UI **同源**（`start.ts:116` 把 `express.static(webDir)` 挂在同一个 app 上），
  脚本即获得 `fetch('/api/exec')` 等全 API 能力——按 `docs/bugs/README.md` 已认定的口径，
  `/api/exec` 是 RCE 级端点。）

- **证据等级**：**E3b**（理由：起隔离实例 + 打真实 HTTP 端点 + 断言**真实响应头与响应体**。
  这是「HTTP 缺陷 = 起隔离实例打真实端点」的标准形态。）

- **执行环境**：运行时 **Node v25.6.0**（产品 dev 运行时）· 工具链：无（curl 打真端点）· 平台 darwin-arm64
  - 为什么这个环境代表用户：同 oc-001——这就是 `pnpm --filter @zn-ai/zai dev` 起的真实例，
    请求打到真 Express 路由、真磁盘文件、真响应头。

- **位置**：
  - `packages/zai/src/server/routes/desktopWallpaper.ts:29` —— `'image/svg+xml': '.svg'` **在白名单里**
  - `packages/zai/src/server/routes/desktopWallpaper.ts:104-106` —— 回吐时**只设了 `Content-Type` 与 `Cache-Control`**：
    ```ts
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.end(buf)
    ```
  - **对照（同一仓库、同一威胁、已加固）**：`packages/zai/src/server/routes/fs.ts:1391-1396`
    ```ts
    // 图片(尤其 .svg)可能被用户直接开在地址栏:SVG 内嵌脚本会以应用
    // origin 执行。nosniff 阻止 MIME 混淆,CSP sandbox 把文档隔离到
    // unique origin,脚本无法再访问本机 API(2026-09-24 加固)。
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', 'sandbox')
    ```
  - 上传入口：`packages/zai/src/web/src/components/desktop/WallpaperUploadField.tsx:37`
    （`file.type.startsWith('image/')`，`image/svg+xml` 通过）与 `:82`（`accept="image/*"`）

- **触发路径**：
  用户在 `/desktop` 桌面页选一张 `.svg` 作壁纸 → `WallpaperUploadField.upload()` (`WallpaperUploadField.tsx:36`) →
  `api.put('/desktop/wallpaper', { dataUrl })` (`:51`) →
  `PUT /api/desktop/wallpaper` (`desktopWallpaper.ts:46`) → MIME 命中白名单 `:51-52` →
  落盘 `<ZAI_DATA_DIR>/desktop/wallpapers/<id>.svg` (`:67`) →
  前端把返回的 URL 存进 localStorage（`Desktop.tsx:159,551`）→
  之后**用户直接打开该 URL** → `GET /desktop/wallpaper/:id` (`desktopWallpaper.ts:84`) →
  `:104-106` 以 `Content-Type: image/svg+xml` 回吐，**无 nosniff、无 CSP** →
  **出错点：SVG 内的 `<script>` 在应用 origin 下执行**。

- **现象**：预期 —— 要么拒绝 SVG 上传，要么像 `/fs/raw` 那样加 `nosniff` + `CSP: sandbox`，
  使脚本被隔离到 unique origin。实际 —— 脚本在应用 origin 执行，注释里写明的防护在隔壁端点有、这里没有。

- **影响**：
  同源脚本可 `fetch()` 本机 API。`/api/exec` 的命令白名单含 `node`/`npx`（`routes/exec.ts:9-20`），
  即**读文件、发起请求均可**；还可读 `localStorage`（含会话信息）、改任意 settings。
  在 `--lan` 模式下（host `0.0.0.0`）受害者面更大（虽然 `--lan` 无鉴权本身是已知 bug，
  这里**不重复计分**，只指出本条与之叠加）。

- **对照组**（E3 必填，见 §4.7）：

  - **对照组是什么**：**同一个 SVG 文件**，经两条不同的服务端路径回吐，对比响应头。
    这是本条最强的对照——变量只有一个（走哪个路由），SVG 字节完全相同。

  - **对照组输出**：

    ```
    $ # 在实例 cwd 放一个含 <script> 的 .svg，然后走「已加固」的 /fs/raw
    $ curl -s -D - -o /dev/null "http://127.0.0.1:7715/api/fs/raw?path=<abs>/oc-hunt-probe.svg" \
        | grep -iE "^(HTTP|content-type|content-security|x-content-type)"
    HTTP/1.1 200 OK
    Content-Type: image/svg+xml
    X-Content-Type-Options: nosniff          <-- 有
    Content-Security-Policy: sandbox         <-- 有

    $ # 同一个 SVG 字节，经「未加固」的壁纸端点回吐
    $ curl -s -X PUT http://127.0.0.1:7715/api/desktop/wallpaper -H 'content-type: application/json' \
        -d '{"dataUrl":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoZG9jdW1lbnQuZG9tYWluKTwvc2NyaXB0Pjwvc3ZnPg=="}'
    {"ok":true,"id":"wmvb4bbb2-k49hyh","url":"/api/desktop/wallpaper/wmvb4bbb2-k49hyh"}
    $ curl -s -D - -o /dev/null "http://127.0.0.1:7715/api/desktop/wallpaper/wmvb4bbb2-k49hyh" \
        | grep -iE "^(HTTP|content-type|content-security|x-content-type)"
    HTTP/1.1 200 OK
    Content-Type: image/svg+xml               <-- 两条防护都没有

    $ # 响应体确实是带脚本的 SVG 原样回吐
    $ curl -s "http://127.0.0.1:7715/api/desktop/wallpaper/wmvb4bbb2-k49hyh"
    <svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>
    ```

    补充对照组（PNG，证伪「所有壁纸都缺头」这一替代解释——缺是真的，但只有 SVG 可执行）：

    ```
    $ curl -s -D - -o /dev/null "http://127.0.0.1:7715/api/desktop/wallpaper/<png-id>"
    HTTP/1.1 200 OK
    Content-Type: image/png
    ```

  - **它为什么有区分力**：两侧是**同一份 SVG 字节**，唯一变量是路由。
    若差异来自「文件内容」「浏览器行为」「curl 版本」等替代解释，两侧响应头应当相同——实测不同。
    PNG 对照进一步说明：缺头不是全端点通病，而是**恰好漏在了唯一能执行脚本的那一类 MIME 上**，
    这正是缺陷的本质（不是「风格不一致」，是「该防的那一类没防」）。

  - **状态复位**：`desktopWallpaper.ts:72-80` 的旧壁纸 GC 是 fire-and-forget 的，
    每次 PUT 会清掉目录里其余图片。因此每次实验后我都**重新上传**被测文件再取头，
    **不存在「上一轮的文件残留导致对照失真」**（实测：连续两次上传后第一个 id 返回 404、第二个 200，
    证明 GC 确实在跑，我的对照组取的是当轮真实存在的文件）。
    探针文件 `oc-hunt-probe.svg` 用完**立即删除**（见下自证），未留在仓库。

- **复现步骤**：
  1. 起隔离实例（同 oc-001）
  2. `printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>' | base64`
  3. `curl -X PUT .../api/desktop/wallpaper -d '{"dataUrl":"data:image/svg+xml;base64,<上面>"}'`
  4. `curl -D - -o /dev/null .../api/desktop/wallpaper/<id>` → 只有 `Content-Type`，无 nosniff / CSP
  5. 对照：把同样字节放进实例 cwd，`curl -D - .../api/fs/raw?path=<abs>` → **有** nosniff + CSP sandbox
  6. 删掉探针文件

- **复现命令与输出**：

  ```bash
  # 实验组
  SVG='<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
  R=$(curl -s -m 10 -X PUT http://127.0.0.1:7715/api/desktop/wallpaper \
        -H 'content-type: application/json' \
        -d "{\"dataUrl\":\"data:image/svg+xml;base64,$(printf '%s' "$SVG" | base64 | tr -d '\n')\"}")
  ID=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
  curl -s -m 10 -D - -o /dev/null "http://127.0.0.1:7715/api/desktop/wallpaper/$ID" \
    | grep -iE "^(HTTP|content-type|content-security|x-content-type)"
  # 实测输出：
  #   HTTP/1.1 200 OK
  #   Content-Type: image/svg+xml
  #   （无 X-Content-Type-Options / 无 Content-Security-Policy）

  # 对照组（同一 SVG，走已加固的 /fs/raw）
  printf '%s' "$SVG" > /Users/ethan/code/opencc-web/packages/zai/oc-hunt-probe.svg
  curl -s -m 10 -D - -o /dev/null \
    "http://127.0.0.1:7715/api/fs/raw?path=/Users/ethan/code/opencc-web/packages/zai/oc-hunt-probe.svg" \
    | grep -iE "^(HTTP|content-type|content-security|x-content-type)"
  # 实测输出：
  #   HTTP/1.1 200 OK
  #   Content-Type: image/svg+xml
  #   X-Content-Type-Options: nosniff
  #   Content-Security-Policy: sandbox
  rm -f /Users/ethan/code/opencc-web/packages/zai/oc-hunt-probe.svg   # 探针用完即删
  ```

  **与 §3.4 基线的差集**：本条不涉及 typecheck，无差集可报。

- **修复方案**：两处都改，建议二选一或都做：
  1. **最小改动（与既有约定一致，推荐）**：改 `packages/zai/src/server/routes/desktopWallpaper.ts:104-106`，
     在 `res.setHeader('Content-Type', mime)` 之后补上与 `fs.ts:1394-1395` 逐字相同的两行：
     ```ts
     res.setHeader('X-Content-Type-Options', 'nosniff')
     res.setHeader('Content-Security-Policy', 'sandbox')
     ```
     副作用：`CSP: sandbox` 会让直接打开 SVG 时脚本失效——但壁纸本来就不需要脚本，安全。
  2. **更彻底**：把 `MIME_EXT` (`:22-30`) 里的 `'image/svg+xml': '.svg'` 删掉，直接不接受 SVG 壁纸。
     副作用：SVG 壁纸（矢量、可无损缩放）是合理需求，建议只做方案 1。

  另建议：把 `fs.ts:1391-1396` 那两行的加固抽成一个共享 helper
  （如 `setImageSafetyHeaders(res)`），否则「加了一处忘了另一处」会重演。

- **不可触发自证**：本条**不声称「当前不可触发」**——上传路径已实证走通
  （`PUT` 返回 200、`GET` 回吐脚本字节），无需自证。**触发所需的用户动作我如实写在上面**：
  需要一次直接导航到壁纸 URL。

- **上游对照**（选填，加分项）：本条全在 `packages/zai` 一手代码内，**不适用**。

---

### [oc-003] AA 审批被中断后，root 进程的 `noticeStore` 永久保留该卡片并持续对外供应

- **严重度**：**S3**（理由：内存无界增长 + 对外供应已取消的交互。
  我**没有**报 S2，尽管子 agent 初稿报的是更高档——因为我实测确认了**误批准不成立**：
  点那张僵尸卡片会转发 `decision:'approved'`，但 child 侧 registry 已经没有该 `toolUseId`，
  `POST /api/agent/approve` 对未知 id 返回 `404 no_pending_review`（实测，见下）。
  所以**不会批准错误的工具**，剩下的损害是 root 侧内存驻留 + AA 客户端持续渲染一张失效卡片 = 边界退化。）

- **证据等级**：**E3a**（理由：附可运行的最小复现物 `/tmp/bughunt-opencc/notice-store.mjs`，
  完整命令与输出见下。**未起真服务打真端点**——根因是「一个模块级 Map 缺少某条删除路径」，
  用真实 `noticeStore` 源码逐字复刻 + grep 全仓调用点来证明「该路径不存在」，比跑真端点更有区分力。
  注意：按 §4.2，若被认定为「组件层/前端行为」则要按 E2 计——**本条是服务端内存状态，不属该档**。）

- **执行环境**：运行时 **Node v25.6.0**（产品运行时）· 工具链：无（纯 node 脚本，无 mock 框架）· 平台 darwin-arm64
  - 为什么这个环境代表用户：`noticeStore` 是纯内存 `Map`，行为与运行时无关；
    复现脚本**未使用 `vi.mock` / `mock.module`**，也未替换被测对象——它就是源码逐行复刻。
    真实性来自**grep 全仓调用点**（下面「对照组」里贴了），而不是来自执行环境。

- **位置**：
  - `packages/zai/src/server/services/aaClient/noticeStore.ts:31` —— 无界的模块级 `byId` Map
  - `packages/zai/src/server/services/aaClient/noticeStore.ts:43-45` —— **唯一**的按条删除 `resolveNotice`
  - `packages/zai/src/server/services/aaClient/noticeStore.ts:48-54` —— `listNoticesForSession`，
    对外供应 `session.notices` RPC 的数据源
  - `packages/zai/src/server/services/aaClient/reverseDispatch.ts:2054` —— `resolveNotice` 的**唯一**调用点
    （在 `handleInteractionRespond` 内，即「用户点了卡片」）
  - `packages/zai/src/server/services/aaClient/reverseDispatch.ts:2743` —— `session.notices` RPC 处理器
  - `packages/zai/src/server/services/aaClient/eventAdapter.ts:398` —— `registerNotice` 唯一写入点

- **触发路径**：
  AA 客户端触发一次审批（`eventAdapter.handlePromptNotice` → `registerNotice` (`eventAdapter.ts:398`)
  → root 的 `byId.set` (`noticeStore.ts:35`)) →
  用户改主意，**按停止而不是作答** →
  `handleInterrupt` (`reverseDispatch.ts:2022-2027`) → `forwardToChild(childPort,'interrupt',…)` →
  child `pushAction.ts:156` 映射到 `/api/agent/abort` → child `agentRuntime.ts:982`
  `approveRegistry.abortAll(...)` 清掉 child 侧 pending →
  **出错点：root 侧没有任何一环能触及 `byId`** —— 该 `StoredNotice` 连同完整 `NoticeIn` 永久驻留，
  且 `listNoticesForSession` (`noticeStore.ts:48`) 会把它**继续供应**给 AA 服务端。

- **现象**：预期 —— turn 被中断时，root 侧对应的 notice 一并作废（不再供应、释放内存）。
  实际 —— 每次「中断一个未回答的审批」都在 root 留一条永不回收的记录，
  并被 `session.notices` 持续供应，AA 客户端继续把它当**活着的**审批卡渲染。

- **影响**：
  - 对用户：AA 客户端里一张已被取消的审批卡一直挂着；点它也只会得到静默失败。
  - 对内存：`StoredNotice` 持有完整 `NoticeIn` body（`noticeStore.ts:21-29`，含 questions 全文），
    root 进程内**无上界增长**，且只有重启才清。
  - **明确不构成**：误批准（已实测证伪，见「对照组」）。

- **对照组**（E3 必填，见 §4.7）：

  - **对照组是什么**：**同一条删除路径，在「已作答」情形下确实会清空**。
    变量只有一个：走 `handleInteractionRespond`（有 `resolveNotice`）还是走 `handleInterrupt`（没有）。
    再叠加一层**全仓调用点穷举**，证明不存在第三条删除路径。

  - **对照组输出**：

    ```
    [control]   after register            : size=1  served=1
    [control]   after resolveNotice      : size=0  served=0        <-- 已作答：确实清空
    [experiment] after 51 interrupts       : size=51 served=51       <-- 中断：一条不回收
    [experiment] root still serves         : 51 stale approval cards

    removal paths that exist in noticeStore.ts: registerNotice, resolveNotice(byId.delete), resetNoticesForTests(byId.clear, test-only)
    resolveNotice call sites in repo (grep):  reverseDispatch.ts:2054  <-- handleInteractionRespond ONLY
    => no dropNoticesForSession / no abort hook / no disconnect hook exists.
    ```

    「误批准不成立」的真端点实测（在隔离实例 7715 上打）：

    ```
    $ curl -s -X POST http://127.0.0.1:7715/api/agent/approve \
        -H 'content-type: application/json' \
        -d '{"toolUseId":"t-exp-stale","decision":"approved"}' -w "HTTP=%{http_code}\n"
    HTTP=404
    {"error":"no_pending_review"}
    ```

  - **它为什么有区分力**：对照组输出与实验组**不同**（`0` vs `51`），说明 `byId` 本身是可清空的、
    机制没坏，缺的是**特定事件下的删除触发**——这正是缺陷的形状，而不是「Map 坏了」。
    调用点穷举（grep 全仓 `resolveNotice|registerNotice|listNoticesForSession`，5 处命中已全部列在「位置」里）
    排除了「存在我没找到的清理路径」这一竞争假设。

  - **状态复位**：`noticeStore` 是模块级单例，**这正是 §3.2 第 6 条警告的形态**。
    我的复现脚本每段实验开头都调 `reset()`（对应源码里的 `resetNoticesForTests`，
    `noticeStore.ts:57-59`），对照组与实验组**不共享任何一条记录**——
    实验组的 51 条全部是实验组自己 `registerNotice` 进去的，对照组那条 `n-ctl` 已在此之前被清空。

- **复现步骤**：
  1. 跑 `/tmp/bughunt-opencc/notice-store.mjs`（无副作用，不碰磁盘/网络/`~/.zai`）
  2. 或在源码层复核：`grep -rn "resolveNotice" packages/` → 只有 `noticeStore.ts` 定义 +
     `reverseDispatch.ts:2054` 一处调用

- **复现命令与输出**：

  ```bash
  $ node /tmp/bughunt-opencc/notice-store.mjs
  [control]   after register            : size=1  served=1
  [control]   after resolveNotice      : size=0  served=0
  [experiment] after 51 interrupts       : size=51 served=51
  [experiment] child aborted all 51      : approveRegistry/askRegistry emptied (separate process)
  [experiment] root still serves         : 51 stale approval cards

  removal paths that exist in noticeStore.ts: registerNotice, resolveNotice(byId.delete), resetNoticesForTests(byId.clear, test-only)
  resolveNotice call sites in repo (grep):  reverseDispatch.ts:2054  <-- handleInteractionRespond ONLY
  => no dropNoticesForSession / no abort hook / no disconnect hook exists.

  # 调用点穷举（裁判可独立重跑）
  $ grep -rn "resolveNotice\|registerNotice\|listNoticesForSession" packages/
  packages/zai/src/server/services/aaClient/noticeStore.ts:34:  export function registerNotice(...)
  packages/zai/src/server/services/aaClient/noticeStore.ts:43:  export function resolveNotice(...)
  packages/zai/src/server/services/aaClient/noticeStore.ts:48:  export function listNoticesForSession(...)
  packages/zai/src/server/services/aaClient/noticeStore.ts:57:  export function resetNoticesForTests(...)
  packages/zai/src/server/services/aaClient/eventAdapter.ts:59:  import { registerNotice } ...
  packages/zai/src/server/services/aaClient/eventAdapter.ts:398:    registerNotice({
  packages/zai/src/server/services/aaClient/reverseDispatch.ts:47:  import { getNotice, listNoticesForSession, resolveNotice } ...
  packages/zai/src/server/services/aaClient/reverseDispatch.ts:2054:    resolveNotice(p.noticeId);
  packages/zai/src/server/services/aaClient/reverseDispatch.ts:2743:    return { sessionId: p.sessionId, notices: listNoticesForSession(p.sessionId) };
  ```

  **与 §3.4 基线的差集**：本条不涉及 typecheck，无差集可报。

- **修复方案**：在 `noticeStore.ts` 增加一个按会话批量清理的入口（与 `askRegistry.abortAll(reason, sessionId)`
  的既有形状对齐），然后在 **root 自己**的 abort/interrupt 处理里调用它：
  - 新增 `dropNoticesForSession(zaiSessionId: string): void`，遍历 `byId` 删除 `entry.zaiSessionId === zaiSessionId` 的条目
  - 在 root 侧收到会话中断时调用（child 无法代劳——这是两进程结构决定的，
    `handleInterrupt` 只做了 `forwardToChild`，root 侧自己没有任何状态变更）
  - 顺手把 `StoredNotice.createdAt`（`:28`，已在存）用起来：给 `listNoticesForSession` 加 TTL 兜底，
    即使漏掉某条路径也不会无限驻留
  - 副作用注意：`handleInterrupt` 在 `reverseDispatch.ts:2022` 拿到 `zaiSid` 即可调用，
    不需要额外的 RPC；改完应补一条测试断言「中断后 `listNoticesForSession` 返回空」
    ——目前 `resetNoticesForTests` 是**唯一**能验证该 Map 清空的函数，说明这块**没有生产侧测试覆盖**。

- **不可触发自证**：本条**不声称不可触发**。触发需要 AA 功能启用 + 一次「发起审批后改为中断」的用户操作，
  我在「触发路径」中如实写明了这一前置条件。AA 通道本身需要用户在设置里开启。

- **上游对照**（选填，加分项）：本条全在 `packages/zai` 一手代码内（`aaClient/` 是 zai 自有的 AA 集成层），
  **不适用**。

---

## 四、汇总表

| ID | 标题 | 严重度 | 证据等级 | 位置 |
|---|---|---|---|---|
| oc-001 | 设 `ZAI_DATA_DIR` 的隔离实例仍读写用户真实 `~/.zai/settings.json` | S1 | E3b | `packages/zai/src/server/services/zaiSettingsStore.ts:35` |
| oc-002 | 壁纸端点回吐带脚本 SVG 且无 `nosniff`/`CSP`（同仓 `/fs/raw` 已加固同一威胁） | S2 | E3b | `packages/zai/src/server/routes/desktopWallpaper.ts:104` |
| oc-003 | AA 审批被中断后 root 侧 `noticeStore` 永不回收并持续供应僵尸卡片 | S3 | E3a | `packages/zai/src/server/services/aaClient/noticeStore.ts:43` |

**正式报告条目数**：3　**其中 E0 条数**：0

**自估得分**：oc-001 = 10 × 1.0 = 10；oc-002 = 6 × 1.0 = 6；oc-003 = 3 × 1.0 = 3。合计 **19**。
（按 §6.2 口径自测：落在「1 条 S1/E3 + 1 条 S2/E3 + 更少」的量级区间。我清楚这远低于满分区间——
 见第六节，这是取舍的结果，不是不知道差距。）

> **oc-003 的来源与降档说明**：这条最初由我派出的子 agent 报上来，我**没有直接采信**：
> 逐条核了它给的 5 个 `file:line`（全部对得上），又自己 grep 穷举了 `noticeStore` 的全部删除路径
> （确认 `resolveNotice` 全仓只有一个调用点），最后**在真端点上实测证伪了它「可能误批准工具」的部分**，
> 据此把严重度从子 agent 初稿的更高档**降到 S3**。子 agent 的结论我用了，但结论的**定级是我自己重判的**。

---

## 五、不确定与自我否定清单

| 线索 | 位置 | 为什么站不住 / 为什么没能证实 |
|---|---|---|
| oc-002 是否该报 S1？ | `desktopWallpaper.ts:104` | 我先按 S1 起草，**推翻了自己**。正常 UI 路径用 CSS `background` 消费壁纸（`Desktop.tsx:540` `center/cover url(...)`），浏览器对 background-image 中的 SVG 不执行脚本；触发需用户直接导航 URL。故降为 S2。**没有按 S1 虚报去博分**。 |
| 壁纸 URL 在 dev 模式下与 UI 不同源（8101 vs 7715），算不算缓解？ | — | 部分缓解但**不能**据此降级：`start.ts:116` 在生产模式下把 `express.static(webDir)` 挂到同一个 app，URL 与 UI **同源**。我按生产形态定级，并在 oc-002 正文写明 dev/prod 差异。 |
| `sweepArchiveFinishedTasks` 的 in-flight 去重有竞态？ | `historyArchive.ts:123-130` | 追完：`inFlight = doSweep().finally(() => { inFlight = null })`，`finally` 保证异常也清空，无泄漏。**证伪，不报。** |
| `RepoRoots` 缓存 TTL 60s 会不会让新建仓库不显示？ | `gitService.ts:248-256` | 60s TTL 对「打开面板」完全够用，且 `repoRootsInFlight` 做并发去重。属设计取舍，不构成缺陷。**不报**（按 §4.6「不得把上游设计如此的行为当 bug」）。 |
| `writeSse` 对非 EPIPE 错误 `throw`，会不会打断其它订阅者？ | `sse.ts:41` + `eventBus.ts:234-243` | 实测复现：`eventBus.emit` 的索引循环会 `splice` 掉抛错订阅者并继续投递后面的，**后续订阅者事件数不受影响**（A 抛错时 B/C 各收 2 条 vs 对照组各 1 条，B/C 完全正常）。**防护到位，证伪，不报。** |
| `TerminalService.closedIds` 只增不减，是否无限增长？ | `TerminalService.ts:27,155` | 每个 sessionId 独立 `Set`，且会话删除时 `disposeSession` 连 `closedIds` 一起丢弃（`:164`）。增长上限=单会话终端数（≤8）。**证伪，不报。** |
| `elicit` 通道挂死（MCP elicit 的 promise 永不 settle）？ | `inboxMessageHandler.ts:455`、`elicitationRegistry.ts:44` | `ElicitationRegistry` 确实**没有** `abortAll`（其自身注释 `:8-12` 承认是 P3 未做），`requestElicit` 的 promise 也无人 resolve。但全仓只有**测试**调 `dispatchDshInbox`（grep 确认：`dispatchDshInbox` 的调用点仅 `inboxMessageHandler.test.ts`），生产无触发者。**按「当前不可触发」处理，不报正式条目**——且我无法按 §4.2 自证「不可触发」（那需要穷举未来创建点）。 |
| `compat/` 深层（subprocess / bashTracker / dangling-shims）是否有契约漂移？ | `packages/zn-agent-core/src/compat/` | **未完成**。派出的子 agent 跑了约 40 分钟未返回任何结果，已终止。这是本次最大的覆盖缺口，我不掩饰。 |
| 子 agent 另报：并发 delete+start 会留下孤儿 child 实例 | `routes/instances.ts:310`、`instanceSupervisor.ts:372` | 子 agent **自己标注「未经执行验证」**，且我没来得及独立复核。按 §12「禁止编造」+ §4.2，我不把它写成正式条目。要注意它与已知清单里的 `instance-supervisor-double-spawn` **高度疑似同源**（都是 `doStart`/`doRemove` 的并发交错），即使验证通过也可能因重报而作废。 |
| 子 agent 另报并**自行证伪**的假设：root 实例会话删除会泄漏 AA session mapping | `aaClient/eventAdapter.ts:302` | 子 agent 追到 `SessionMap.put` 的 port 只来自 `RuntimeRegistry.mappings`，而该表只由 `handleInstanceChanged` 填充；root 从不为自己发 `instance.changed`（`CURRENT_INSTANCE_ID` 只存在于合成的 `currentSnapshot()`）。**链条自洽，我采信其证伪**，不报。 |
| `/api/fs/content-search` 的 ripgrep 超时是否真会 flaky？ | `routes/fs.ts:1055` | AGENTS.md 明确 `replHistory ?q=` 30s 超时是**已知 flaky**，§3.2 第 4 条禁止用「跑全量看到红」论证。我**没有**拿它当发现。 |
| `mainAgents.ts` / `mcpConfig.ts` / `fileStore.ts` 也漏了 `ZAI_DATA_DIR` | 见 oc-001 同类清单 | 这 7 处我**只做了 grep 定位 + 对照写法比对**，**没有逐条起实例实证**。因此我**没有**把它们拆成 7 条独立报告（§4.6 禁止同根因拆分刷数量），只作为 oc-001 修复范围列出。 |

---

## 六、给裁判的一句话

我这一轮只交了 3 条，是因为我把时间几乎全部压在「能拿到可复核的机器证据」上，
并且在追第一条时**撞见了 `ZAI_DATA_DIR` 隔离本身被绕过**——那之后我立刻停手、改为只读取证，
先保证了用户真实数据零写入，再回头写报告。质量上我有信心：oc-002 的对照组是
**同一份 SVG 走两条路由**，oc-003 的对照组是**同一条删除路径在「已作答」时确实清空**，
这两组我认为都很难被推翻。
数量上我认输：vendor 那 55 万行我一行没挖，一个子 agent 超时、另一个的结论我逐条复核后
还把它的定级**往下压了一档**（因为我自己实测证伪了它「会误批准」的部分）——
这一轮我只信自己核过的东西。

---

## 附：收口自证（铁律合规）

本节供裁判低成本核验我是否踩了红线。

```bash
$ git rev-parse HEAD
6f9ceaeb7c9bf63e71f4deea9346f790a107ea14        # 与开局快照一致，未 commit/reset/checkout

$ git status --porcelain
?? docs/bugs/bug-hunt-game-10-16/                 # 仅本目录；packages/ 下零改动

$ stat -f "%Sm %N" ~/.zai/settings.json
Oct 16 22:50:23 2026 /Users/ethan/.zai/settings.json
                                                 # mtime 早于本次会话 → 未写入用户数据

$ ls /tmp/bughunt-opencc/                          # 全部临时产物都在 /tmp
ap1.txt ap2.txt c.png dev.log e.svg get-settings.json got.svg head.txt
hunt-repo pty-raw.mjs px.png r1.txt r2.txt set.json sse-emit.mjs
status-before.txt symtest tc-core.log tc-zai.log zai-home
```

- **未读他人报告**：环节一全程未打开任何 `bug-hunt-{claude-code,workbuddy,trae-code}.md`
  或 `hunt-review-*.md`。子 agent 的 prompt 里也显式禁止了它们去读。
- **未跑全量测试**：只跑了两个包的 `typecheck`（非测试）+ curl 真实端点，未执行 `pnpm -r test`。
- **临时文件清理**：为 oc-002 对照临时放进仓库的 `oc-hunt-probe.svg` **已删除**，
  `git status` 复核干净（上表可验）。未发生「写进仓库再删」的隐瞒情形。
- **用户实例**：9201 全程只在 `lsof` 中被**观察**，未 kill、未连接、未占用。
- **我的实例**：8101 / 7715，PID 75407，在环节一结束后可由我关闭。
