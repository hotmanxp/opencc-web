# 缺 Host 头校验导致 DNS rebinding 任意文件读

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 高（任意文件读取）
**发现：** zai

## 摘要

Express 服务**不校验 `Host` 头**，也不校验 `Origin`。攻击者把一个自己的域名
的 DNS 解析到 `127.0.0.1`，让受害者访问 `http://attacker.example:9201` ——
此时浏览器认为自己在跟 `attacker.example` 通信（同源），请求实际打到了本机
zai。这就是 DNS rebinding。

`GET /api/fs/file/preview` 与 `GET /api/fs/raw` 直接把 query 里的 `path`
`pathResolve()` 后交给 fs，**不经过 `resolveSafePath`**，因此 rebinding 后
可读取 `~/.ssh/id_rsa`、`~/.zai/settings.json`（含 API key）等任意文件。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/routes/fs.ts` | 1190 | `const abs = pathResolve(raw)` —— preview 路由，**无 `resolveSafePath`** |
| `packages/zai/src/server/routes/fs.ts` | 1336 | `const abs = pathResolve(raw)` —— raw 路由，**无 `resolveSafePath`** |
| 全服务树 | — | 零 `req.headers.host` / `Origin` 校验 |

两处都只做了 `\x00` 检查（`:1331`）和扩展名白名单（`:1337`），
**没有任何路径包含性检查**，也没有 cwd 锚定。

对比：同文件的 `PUT /fs/file`（`:548`）和 delete（`:1516`）都调用了
`resolveSafePath(cwd, rel)` —— 说明这是**同文件内的不一致**，不是全局设计。

## 实证

代码层确认（`sed` 读 `fs.ts:1185-1195` / `:1328-1340`）：

```
fs.ts:1190   const abs = pathResolve(raw)      // 直接 resolve，无包含性检查
fs.ts:1336   const abs = pathResolve(raw)      // 同上
```

`grep -rn "req.headers.host\|req.get('host')\|Origin" packages/zai/src/server`
（排除 `.test.`）**零命中** —— 没有任何 Host / Origin 校验中间件。

## 为什么 localhost 绑定不构成缓解

**DNS rebinding 正是绕过监听地址的手段。** 服务只监听 `127.0.0.1` 毫无作用：
攻击者的域名解析到 `127.0.0.1` 后，浏览器仍然能建立连接。这与 CSRF
[同源策略绕过](2026-10-05-exec-csrf-rce--by-zai.md)是同一类问题的两面。

## 修复

1. **加 Host 白名单中间件**（首要，一并修掉 exec RCE 的 rebinding 变体）：
   在 `app.use('/api', ...)` 之前插入，只接受 `localhost` / `127.0.0.1` /
   `[::1]` 以及 `--lan` 模式下显式放行的本机 LAN IP。必须放在**所有**路由之前。
2. **给 preview / raw 两条路由加路径约束**。这两条是「不限 cwd」的预览接口，
   与其余 fs 路由的 cwd 锚定语义不一致 —— 要么补 `resolveSafePath`，
   要么显式承认它们是任意路径读取接口并加独立的授权判断。

注意 `resolveSafePath` 自身**不跟随符号链接**（见
[符号链接穿透](2026-10-05-symlink-traversal-write-delete--by-zai.md)），
所以对 write/delete 语义够用；但对「读」来说这恰好是需要的额外保护。

## 关联

- [跨站 RCE](2026-10-05-exec-csrf-rce--by-zai.md) —— 同一根因（无 Host 校验），
  且 `/api/exec` 在 `index.ts:249` 与 fs 路由同挂在 `/api` 下。
- [符号链接穿透](2026-10-05-symlink-traversal-write-delete--by-zai.md) ——
  `safePath.ts` 的注释「端点只读故已缓解」已不成立。
