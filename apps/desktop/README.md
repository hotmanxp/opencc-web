# @zn-ai/desktop

zai 的 Electron 桌面壳。它不是第二个前端,而是把已经构建好的 zai Web 应用装进一个原生窗口,并接管它的进程生命周期。

## 架构

```
Electron 主进程(lib/main.js)
  ├─ BrowserWindow ──▶ http://127.0.0.1:<port>   zai 自己的 origin,原生 HTML/CSS/JS
  ├─ zai 子进程 ────▶ ELECTRON_RUN_AS_NODE=1 electron <zai>/dist/cli/index.js start --port <p> --no-open
  │                     环境: ZAI_NO_MANAGED=1(不再套一层 supervisor)
  └─ 就绪探针 ──────▶ GET /api/health 轮询
```

三条设计取舍:

1. **不引入自定义协议,也不加 preload**。zai 本来就监听 loopback、自带 web 产物、路由无鉴权,所以窗口直接加载 `http://127.0.0.1:<port>` 即可 —— 不需要 `dsh-app://` 那样的特权协议,也不需要向渲染进程暴露任何桥。窗口保持 `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false` / 无 preload,是最小攻击面。
2. **子进程用 Electron 自带的 Node 跑**(`ELECTRON_RUN_AS_NODE=1`),不额外打包一份 Node 运行时。代价见「已知限制」的 ABI 一条。
3. **端口稳定优先**。默认从 `9201` 起找第一个空闲端口并显式传给 zai,因此常规启动下 origin 不变,`localStorage` 等浏览器状态得以跨启动保留。

## 目录

| 路径 | 职责 |
|---|---|
| `src/main.ts` | Electron 主进程:单实例锁、窗口、菜单、启动失败对话框、退出清理 |
| `src/zai-process.ts` | 子进程管理:端口探测、spawn、`/api/health` 就绪探活、SIGTERM→SIGKILL |
| `src/paths.ts` | 运行期路径推导(开发态 vs 打包态),不含 `electron` 依赖以便被脚本复用 |
| `renderer/loading.html` | 服务启动期间显示的加载页(静态资源,构建期不处理) |
| `scripts/target.mjs` | 目标平台词汇表(`mac-arm64` / `mac-x64` / `win-x64`)与各目标构建目录 |
| `scripts/prepare-runtime.mjs` | `pnpm deploy` 出 zai 的自包含运行时树 |
| `scripts/electron-builder-config.mjs` | electron-builder 配置工厂 |
| `scripts/package-target.mjs` | 打包编排:构建 → 准备运行时 → electron-builder |
| `scripts/dev.mjs` | 开发启动器:构建后启动未打包的 Electron |
| `resources/icon.png` `resources/icon.ico` | 应用图标(取自 `packages/zai/public/favicon-512.png` 与 `favicon.ico`) |

构建产物:`lib/types/`(tsc 中间产物)、`lib/main.js`(tsdown 单文件 ESM bundle)、`.desktop-build/`(开发态 Chromium profile + 各目标打包产物)。

## 命令

```bash
# 开发:构建 workspace + 壳,然后启动未打包的 Electron
pnpm run dev:desktop            # 仓库根
pnpm --filter @zn-ai/desktop dev

# 跳过构建,直接启动已有产物
pnpm run start:desktop

# 只看打包配置,不构建
pnpm run check:desktop

# 打包(macOS 目标需在 macOS 上执行)
pnpm run package:desktop:mac:arm64
pnpm run package:desktop:mac:x64
pnpm run package:desktop:mac:arm64:dir     # 只出 .app 目录,不出 dmg/zip
pnpm run package:desktop:win:x64           # 需在 Windows x64 上执行
```

`package:*` 每次都会重新构建 workspace 与壳,再从零 deploy 运行时树,因此不会消费上一次的中间产物。

## 配置(环境变量)

打包脚本只读进程环境,不加载 `.env` 文件(若需要,后续加一个加载器即可)。

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZAI_DESKTOP_APP_ID` | `com.zn-ai.zai` | 应用标识/包名 |
| `ZAI_DESKTOP_PRODUCT_NAME` | `zai` | 产物名与 `.app` 名;保持 ASCII 以免路径出问题 |
| `ZAI_DESKTOP_TARGET` | 宿主机目标 | 打包目标(`mac-arm64`/`mac-x64`/`win-x64`),由 `package-target.mjs` 注入给配置工厂 |
| `ZAI_DESKTOP_MAC_SIGNING_IDENTITY` | 空 | 设了才签名;留空 = `identity: null`(不签名)。仅 macOS 目标合法 |
| `ZAI_DESKTOP_NOTARIZE` | `0` | 与签名身份同时设置且为 `1` 时才公证 |

运行期(启动器会设置前两个,便于调试):

| 变量 | 默认 | 作用 |
|---|---|---|
| `ZAI_DESKTOP_ZAI_DIR` | 开发态 `<repo>/packages/zai`;打包态 `Resources/zai-runtime` | 覆盖 zai 包位置 |
| `ZAI_DESKTOP_USER_DATA_DIR` | 开发态 `<apps/desktop>/.desktop-build/user-data`;打包态 `<appData>/zai-desktop` | Chromium profile 目录 |
| `ZAI_DESKTOP_WORKSPACE` | 用户主目录 | zai 的工作目录,决定它落到 `~/.zai/projects/<slug>` 的哪个项目 |

## 运行时树从哪来

`scripts/prepare-runtime.mjs` 执行 `pnpm --filter @zn-ai/zai deploy <target>/zai-runtime --prod`,得到一棵自包含目录:

- `dist/`(含 `dist/cli/index.js` 与 `dist/web/` 前端产物)
- `bin/`
- `node_modules/` —— zai 的生产依赖闭包,其中 `@zn-ai/zn-agent-core` 被物化成真实目录(不是 workspace 符号链接),`@zn-ai/zn-agent-core/dist/opencc-core.mjs` 是 esbuild 单文件 bundle,其外部依赖只有 `sharp` / `zod` / `fflate` / `@orama/*`。

这棵树经 `extraResources` 拷到 `Contents/Resources/zai-runtime`,**不进 `app.asar`**。因此 `sharp`、`node-pty`、vendored ripgrep 这些原生模块都是普通文件,不需要 `asarUnpack`。

deploy 之后还会按目标平台裁剪一次:两个 vendored 包会把所有平台打进同一份 tarball,而目标机器上其余平台根本不可达 ——

- `node-pty/prebuilds/<platform>-<arch>/` 合计 23MB,其中目标平台自己的目录约 140KB(Windows ConPTY 那份占了大头);
- `zn-agent-core/vendor/ripgrep/rg-<platform>-<arch>[.exe]` 合计 11.6MB,其中目标平台自己的二进制约 3MB。

裁剪只在**目标平台自己的产物存在时**才执行,所以布局变化时退化为"什么都不删",而不是"把对的那个也删了"。mac-arm64 下运行时树由此从 110MB 降到 **78MB**(未裁剪前是 357MB)。

#### 子进程里的 `node`

Electron 44.4.5 自带 Node 24.21.0(`process.versions.node`),但任何走 PATH 的 `node` 命令 —— PTY shell、agent 的 Bash 工具 —— 默认命中的是系统 Node 22。壳在每次启动时:
- 在 `<userData>/bin/` 下放一个 `node` 符号链接指向 Electron 二进制,并把它放到 zai 子进程的 PATH 最前面(`path.delimiter` 分隔);
- 在同一个 `bin/` 下放 `zsh` 和 `bash` 两个 wrapper 脚本(若 `process.env.SHELL` 是它们,就把 `$SHELL` 指向对应 wrapper);
- 给 zsh wrapper 多导出一个 `ZDOTDIR=<userData>/zsh-init>`,并在那个目录里写一个 `.zshrc`,顺序是 `source ~/.zshenv` → `source ~/.zshrc`(让用户的 nvm/pyenv/asdf 先加载)→ `export PATH="<shim>:$PATH"`(再把 shim prepend 回来,确保 rc 加载后覆盖不过来)。

这样在桌面应用内部 `node` 等同于 Electron 内嵌 Node 24;系统其它地方(`/usr/local/bin/node`、nvm、其它项目)不受影响。仅 zsh/bash 这两条被显式 wrapper 覆盖;fish、自定义 shell 暂未处理。

三点打包细节值得留意:

- `electron-builder` 会丢弃被拷贝源目录**根部**的 `node_modules`,所以 `extraResources` 里 `node_modules` 需要单独一条映射。
- `pnpm deploy` 会打印若干 `Failed to create bin ... ENOENT` 警告(它把相对目标路径错当成相对 zai 包目录解析)。这些只影响 `node_modules/.bin` 里的 shim,而壳是直接用 Electron 跑 `dist/cli/index.js`、ripgrep 也是从 `vendor/ripgrep/` 直接解析的,所以不影响运行。
- **体积的大头不在壳也不在运行时依赖,而在 `packages/zai` 的依赖分类**:前端由 Vite 打成自包含产物(`dist/web`),所以只在 `src/web` 里出现的包若写进 `dependencies`,会被 `pnpm deploy --prod` 原样带进安装包。详见仓库根 `AGENTS.md` 的对应条目(2026-09-25 已把 35 个包挪到 `devDependencies`)。

## 验证状态

已验证(macOS / Apple Silicon,Electron 44.4.5):

- `zai start` 能在 `ELECTRON_RUN_AS_NODE=1` + `ZAI_NO_MANAGED=1` 下启动,`/api/health` 返回 `{"ok":true}`。
- web 产物(`dist/web`)正常托管,`/` 返回 SPA 的 `index.html`;PDF/表格/代码编辑器等懒加载 chunk 与 `pdfjs` 的 worker、cmaps 全部 200。
- `sharp` 加载成功(即使已从 zai 的 `dependencies` 移出,仍由 `@zn-ai/zn-agent-core` 提供并可从打包产物解析);`/api/terminal/environment` 返回 `available: true`,`/api/terminal/create` 起了一个 `zsh`,SSE 快照返回真实提示符 `ethan@liangchaodeMac-mini ~ %` —— 说明裁剪后的 `pty.node` + `spawn-helper` 完全可用。
- 退出后端口释放、无孤儿进程(PTY 子进程被回收)。SIGTERM 路径同样干净。
- `pnpm deploy --prod` 产出的运行时树自包含:`@zn-ai/zn-agent-core` 被物化为树内 `.pnpm` 下的真实目录(相对符号链接,整树拷贝可保留);按目标平台裁剪后只保留 `rg-darwin-arm64` 与 `prebuilds/darwin-arm64`,裁剪后的 ripgrep 实测可执行、可搜索。
- shell bundle 只依赖 `electron` + Node 内置模块。

未验证(需要相应环境,不要当作已通过):

- Windows x64 打包与安装器 —— 需要 Windows 构建主机。
- 代码签名 / 公证 / 真实更新分发 —— 需要 Apple 开发者证书与真实更新源。
- macOS x64(`mac-x64`)产物 —— 配置已就绪,本机只跑了 `mac-arm64`。

## 已知限制

- **Windows 目标只写了配置,未在本机验证**。`win-x64` 需要 Windows x64 构建主机;`resources/icon.ico` 直接取自 zai 的 `favicon.ico`,Windows 打包要求 ICO 至少 256×256,若 electron-builder 报图标尺寸错误需重新导出。
- **未接入代码签名与公证**。默认 `identity: null`,产物是未签名/临时签名的;`ZAI_DESKTOP_MAC_SIGNING_IDENTITY` / `ZAI_DESKTOP_NOTARIZE` 是预留入口,尚未在真实证书下跑通。
- **没有自动更新**。`publish: null`,不产 `latest*.yml`;更新需要重新分发安装包。
- **原生模块 ABI 已实测可用,但仍是环境相关风险**。子进程跑在 Electron 的 Node 模式里,而运行时树里的原生模块是按系统 Node 装的。实测 `sharp`(libvips 8.15.3)与 `node-pty`(1.2.0-beta.15)在 Electron 44 下都能加载,并能真正创建 `zsh` PTY 会话 —— 两者都走 N-API/预编译分发,不依赖 Node 的 NAN ABI。若将来某个原生模块改成 NAN 构建,就会在 Electron 下加载失败;zai 对 `node-pty` 是懒加载 + 优雅降级(PTY 路由 503 + 修复提示),不影响其余功能。
- **开发态 macOS 菜单栏显示 "Electron"**。未打包启动用的是 Electron 官方二进制,`CFBundleName` 无法改;打包后显示 `productName`。开发态控制台还会打印 Electron 的 CSP 警告(zai 的 web 产物没有 CSP),打包后不再出现 —— 它只是开发态噪音,不是缺陷。
- **窗口标题由 web 应用决定**。`main.ts` 的 `title` 只用于窗口创建前的占位;页面加载后 zai 前端会按 cwd 设置 `document.title`(例如在 `/Users/ethan` 下显示 `ethan-Z.AI`)。
- **端口被占用时 origin 会变**,`localStorage` 等浏览器状态随之重置。默认 9201,若被别的 zai 实例占用则顺延到 9202、9203……
- **关闭窗口即退出(含 macOS)**,同时停掉 zai 子进程。这样不会留下看不见却仍在跑的服务;如果更想要 macOS「关窗不退出」惯例,需要单独改造。
