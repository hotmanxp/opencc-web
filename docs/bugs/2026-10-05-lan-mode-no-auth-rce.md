# `--lan` 模式全 API 零鉴权：局域网未授权 RCE + 微信账号控制

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 严重（未授权远程代码执行；影响范围为整个局域网）

## 摘要

zai 的安全模型**完全建立在「只监听 localhost」这一个前提上**，代码注释里写得很明确。
`--lan` 标志的存在目的就是打破这个前提，但**没有提供任何补偿性的访问控制**。

后果：同一 Wi-Fi 下的任意设备可以无凭证执行任意 shell、读写文件、开 PTY、
以用户身份发微信消息、消耗用户的模型 API key。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/index.ts` | 67-70 | 安全模型注释（见下） |
| `packages/zai/src/cli/dev.ts` | 29, 41-42, 123 | `const host = options.lan ? '0.0.0.0' : '127.0.0.1'` |
| `packages/zai/src/cli/start.ts` | 114, 187-191 | 同上 |
| `packages/zai/src/cli/index.ts` | 49, 71 | `--lan` 标志定义 |

`index.ts:67-70` 的原文：

> zai is a local dev tool — **the server only listens on localhost** and every
> route is wide-open to anyone who can reach the port. The original
> tokenGuard middleware added friction (token changes on every server
> restart → 401 → manual paste dance) **without buying real security**.

这里有一个被移除的 `tokenGuard` 中间件。注释论证的是「对 localhost 加 token 没意义」，
这个论证本身成立 —— 但它**没有覆盖 `--lan` 的情形**，而 `--lan` 恰恰是把攻击面
从「本机用户」扩大到「整个局域网」的那个开关。移除 tokenGuard 后没有补上任何东西。

## 无鉴权的高危端点

`grep -rn "authorization\|x-zai-token\|checkToken\|requireAuth" packages/zai/src/server`
只命中**出站**请求头（openaiClient / weixinBot / aaClient），**没有任何入站鉴权**。

| 端点 | 位置 | 能力 |
|------|------|------|
| `POST /api/bash/repl/:sessionId/exec` | `routes/bashRepl.ts:31` | **任意 shell 命令，无白名单** |
| `POST /api/terminal/create` | `routes/terminal.ts` | 持久 PTY（node-pty） |
| `GET /api/fs/file` | `routes/fs.ts:407` | 读取 cwd 树内任意文本文件 |
| `PUT /api/fs/file` | `routes/fs.ts:533` | 写入 cwd 树内文件（需已存在 + 扩展名白名单） |
| `POST /api/exec` | `routes/exec.ts` | 白名单含 `npx` / `node`，等于任意代码执行 |
| `POST /api/agent/prompt` | `routes/agent.ts` | 以用户的 API key 消耗额度 |
| `POST /api/weixin/send` | `routes/weixin.ts` | 以用户身份发微信 |
| `POST /api/weixin/owner/takeover` | `routes/weixin.ts:410` | 清除微信通道 owner 锁 |
| `GET /api/weixin/status` | `routes/weixin.ts` | 泄露 accountId / 通道状态 |
| `/proxy/<port>/<path>` | `services/reverseProxy.ts` | 反代到本机任意端口（仅 `--lan` 启用） |

`/api/exec` 的白名单（`routes/exec.ts:8-19`）值得单独说：注释写着
「Whitelist of allowed commands to prevent arbitrary code execution」，
但名单里的 `npx <任意包>` 和 `node -e "<任意代码>"` 让这个白名单**在语义上等于没有**。

## 实证：本机当前状态

这不是纸面风险。审计时该机器上跑着 4 个绑定在所有接口的 zai 实例：

```
$ lsof -nP -iTCP -sTCP:LISTEN | grep node
node  34110  zai[opencc-web]:9988
node  42945  zai[ethan]:9201
node  42981  zai[weixin-bot]:9199
node  42987  zai[Code-AA]:9233
```

（`*:` 即绑定所有接口，非 127.0.0.1）

`GET /api/system` 未带任何凭证直接返回：

```json
{"platform":"darwin","cwd":"/Users/ethan/weichat-agent",
 "host":"0.0.0.0","port":9199,"ips":["192.168.101.69"],
 "isManagedChild":true,"supervisorPid":42945,"instanceId":"inst_9e..."}
```

`GET /api/weixin/status` 同样无鉴权返回：
`{"state":"connected","accountId":"cdc6ab853280@im.bot","owner":true,...}`

`zai[weixin-bot]:9199` 是 AGENTS.md 记载的微信专用实例，**进程内持有微信账号的
QR 凭据与会话 token**（`~/.zai/weixin/accounts/`、`sessions.json`）。加上
`/api/weixin/send` 与 `/api/weixin/owner/takeover`，局域网内任何设备都能
**完整接管用户的微信 bot 通道**。

## 触发面被 AGENTS.md 主动放大

`AGENTS.md` 记载 lan-agent 的配套启动方式：

> 配套服务端:`pnpm --filter @zn-ai/zai dev -- --lan`(暴露 8101 端口 `/m` MobileAgent 路径)

同时 `lan-agent` 侧还专门配了 `network_security_config.xml` 网络白名单来放行目标 IP ——
说明**「LAN 上有其他不可信设备」这个场景是被识别到的**，但服务端侧没有对应防护。
手机 App 通道把攻击面从「同网段偶然扫到的陌生设备」扩大到「任何能连上该 Wi-Fi 的人」。

## 修复建议

按侵入性从低到高：

1. **最小可行**：把 `--lan` 改成**必须显式提供 token**，例如
   `--lan --token <secret>`，未提供时拒绝启动或降级回 127.0.0.1。
   启动日志打印 token，移动端从 lan-agent 配置读取。
   这比恢复被删的 `tokenGuard` 好在：token 只在真正暴露时才需要，
   默认 localhost 模式完全无摩擦 —— 原注释抱怨的正是这个摩擦。

2. **中间态**：对所有 `/api/*` 加 **Host header 白名单 + Origin 校验**，
   挡掉浏览器侧的 DNS rebinding 与跨站请求（哪怕是内网部署也能显著收窄）。
   当前 `grep -rn "req.hostname\|req.headers.host\|Origin\|cors"` 在
   `packages/zai/src/server` 下**零命中**。

3. **能力面收窄**：`/api/bash/repl/*/exec` 与 `/api/terminal/*` 这类
   任意执行端点，可考虑在非本机来源时额外要求一次性确认 token。
   `/proxy` 同理 —— 它能把本机任意端口代理出去。

4. **产品层面**：在 `--lan` 启动时打印醒目警告，列出当前开放的高危端点清单。
   至少让用户知道自己在做什么。

## 与「localhost 模式也有风险」的区分

即便**不开** `--lan`，绑定 127.0.0.1 也不是零风险：用户浏览的任意恶意网页可以
通过 **DNS rebinding**（把攻击者域名解析到 127.0.0.1）向
`http://127.0.0.1:<port>/api/...` 发同源请求。由于当前**没有 Host 校验**，
Express 认为这是合法请求。`GET /api/exec` 这种 simple request 不触发 CORS 预检，
**副作用（写文件、执行命令）不需要读响应即可完成**。

所以第 2 条（Host 校验）即使在纯 localhost 部署下也建议做。

## 关联问题

- `/api/exec` 的 `cwd`（`routes/exec.ts:43`）与 `POST /tasks` 的 `cwd`
  （`routes/tasks.ts:14`）未做校验。在 localhost 模式下不构成权限边界问题，
  但在 `--lan` 下意味着**攻击者可以把命令的工作目录指向任意绝对路径**。
- `docs/bugs/2026-10-05-repl-registry-child-process-leak.md:64` 提到
  「`--lan` 模式下客户端可创建无限多个并发 shell，且全部不被回收」——
  与本文档是同一个攻击面。
