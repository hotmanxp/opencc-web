# zai SharePopover 移动端扫码二维码 — Design Spec

**日期**: 2026-07-26
**作者**: brainstorming session
**状态**: 设计待 review
**关联 spec**:
- `2026-07-25-zai-agent-share-design.md`(SharePopover 现状)
- `2026-07-26-zai-mobile-agent-design.md`(`/m` 移动端路由 + UA 重定向,已交付)

---

## 1. 背景与目标

zai 当前 SharePopover 仅提供"复制 URL"操作,用户在演示场景中需要把链接发给 LAN 同事的电脑/手机时,**手机**操作成本高(无法粘贴 / 输入 IP)。本期新增"扫码二维码"能力,让用户在手机/平板上扫一下即可进入同一个 session 的只读对话视图。

**目标**:
- SharePopover 顶部增加二维码区,展示当前首选 IP + `sessionId` 对应的移动端 URL
- 复用 antd `<QRCode>` 组件,不新增依赖(`@rc-component/qrcode` 已通过 antd 5 间接引入,锁文件存在)
- 复用已交付的 `/m` 移动端路由(`2026-07-26-zai-mobile-agent-design.md` 已上线)

**非目标(本期不做)**:
- 多 IP 都生成二维码(选第一个 IP 作默认,见 §3)
- 暗色主题适配(范围决策确认)
- PWA / Service Worker / 离线缓存
- 服务端路由变动 / 新端点
- 二维码扫码后行为控制(URL 透传即可)

---

## 2. 用户体验

### 弹窗布局

```
┌────────────────────────────────────────────┐
│  分享到 LAN — 点 Copy 把链接发给同事        │
│                                             │
│        ┌─────────────────────┐              │
│        │                     │              │
│        │    ▓▓▓▓▓▓▓▓▓▓▓▓     │  ← 首选 IP   │
│        │    ▓  QR CODE   ▓   │    QRCode    │
│        │    ▓▓▓▓▓▓▓▓▓▓▓▓     │   196×196    │
│        │                     │              │
│        └─────────────────────┘              │
│   扫码在手机上打开 /m?sid=…                  │
│   首选: 192.168.101.69:9202                  │
│                                             │
│   ── 其它可用 IP(可选)──                    │
│   ┌──────────────────────────────────┐ [复制]│
│   │ 10.0.0.2:9202/agent?sid=sess-1c…   │      │
│   └──────────────────────────────────┘      │
└────────────────────────────────────────────┘
```

### 边界态

- `ctx.ips.length === 0`(未启用 `--lan`):走现有"未启用 --lan"分支,**不显示二维码**
- `!sessionId`:走现有"先开一个会话"分支,**不显示二维码**
- 仅 1 个 IP:隐藏"其它可用 IP"标题 + 隐藏分隔线,只显示 QR + 主 IP 说明
- 多个 IP:副标题"扫码在手机上打开 /m?sid=…" + 主 IP 文本 + "其它可用 IP"列表(每个 row 仍可单独复制 `/agent?sid=` URL,行为与现一致)

---

## 3. 架构

### 改动面

| 层 | 文件 | 变更 |
|---|---|---|
| Web UI | `packages/zai/src/web/src/components/SharePopover.tsx` | 顶部插入 QR 区 + 副标题 + 首选 IP 文本 + 条件渲染"其它可用 IP"分组 |
| Web test | `packages/zai/test/web/SharePopover.test.tsx` | mock antd `QRCode`,新增 3 个 case |

无 server / CLI / store / types 变动。

### 关键决策

#### 3.1 二维码内容 = `/m?sid=xxx`,不走 `/agent`

二维码内容 = `${primaryIp}:${ctx.port}/m?sid=${sessionId}`

- 手机扫码后直接命中 `/m`,不依赖 server `redirectMobileUA` 302 跳转
- 与 `2026-07-26-zai-mobile-agent-design.md` 路由设计一致(已交付的 `/m` SPA 入口)
- 选择理由:二维码是单向传播,跳过中间跳转更直接;若分享给同事的电脑仍可用现有 row 复制 `/agent?sid=` URL(行为不变)

#### 3.2 首选 IP = `ctx.ips[0]`

- 复用 `detectLanIps` 服务端返回顺序(`packages/zai/src/server/utils/lanIps.ts`)
- 不做"按当前访客子网匹配"等额外逻辑,本期保持简单
- 多网卡用户若 `ips[0]` 不可达,可走下方 IP 列表手动选择

#### 3.3 antd `<QRCode>`(不新增依赖)

- 项目已使用 `antd ^5.22`,`<QRCode>` 是其内置组件,基于 `@rc-component/qrcode`(已在 bun.lock / pnpm-lock 中)
- `package.json` 无需新增依赖项,`bun install` 不触发

#### 3.4 二维码渲染样式锁定

```tsx
<QRCode
  value={primaryQrUrl}
  size={196}
  bordered
  color="#000"
  bgColor="#fff"
  icon={undefined}        // 不放 logo,避免扫码失败
  data-testid="share-primary-qrcode"
/>
```

- `bgColor:"#fff"` + `color:"#000"`:锁白底黑前景,扫码库对暗色背景识别率低
- `bordered`:antd 默认带浅灰边框,易与暗色 popover 背景区分
- `icon={undefined}`:不放 logo,缩短容错边距,提高扫码成功率

### 数据流

```
SharePopover mount
  → 读 ctx.ips / ctx.port / sessionId
  → primaryIp = ctx.ips[0]
  → primaryQrUrl = `http://${primaryIp}:${ctx.port}/m?sid=${sessionId}`
  → 渲染 QRCode + 副标题 + 主 IP 文本
  → 若 ctx.ips.length > 1:
       渲染"其它可用 IP" + ctx.ips.slice(1) 行(每行复制按钮走 handleCopy)
```

无 store 变更,无 SSE 事件,无 server 端点。

---

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| antd `QRCode` 内部生成失败(URL 过长 / 浏览器不支持 canvas) | antd 自带 fallback 显示纯文本 URL,客户端无需额外处理 |
| `ctx.ips` 为空数组 | 走现有"未启用 --lan"分支,不渲染 QR 区 |
| `sessionId` 为空 | 走现有"先开一个会话"分支,不渲染 QR 区 |
| 浏览器禁用 canvas | happy-dom / jsdom 测试环境已用 mock `QRCode` 组件绕开(见 §5) |

无新增错误分支,弹窗原有 `handleCopy` 失败路径不变。

---

## 5. 测试策略

在 `packages/zai/test/web/SharePopover.test.tsx` 中:

**mock 策略**:测试文件已有 `vi.mock("antd", …)`,顺带扩展对 `QRCode` 的 stub:

```ts
vi.mock("antd", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    message: { success: …, error: … },
    QRCode: ({ value, ...rest }: { value: string }) => (
      <div data-testid="share-primary-qrcode" data-value={value} {...rest} />
    ),
  };
});
```

- 避免 jsdom canvas 渲染二维码失败
- `data-value` 属性方便断言 `value` prop

**新增 3 个 case**:

1. **多 IP 时 QR 存在**:渲染 `<SharePopover />`,断言 `getByTestId("share-primary-qrcode")` 在 DOM + 副标题"扫码在手机上打开"匹配 + "其它可用 IP"标题匹配 + 2 个复制按钮存在(原 5 个 case 不变)
2. **QR value 正确**:`ctx.ips[0] = "192.168.1.5"`,断言 stub 上 `data-value === "http://192.168.1.5:9888/m?sid=sess-test-123"`
3. **单 IP 时隐藏其它列表**:`useAppStore.setState({ instanceContext: { …, ips: ["192.168.1.5"] } })`,断言 QR 存在 + 找不到"其它可用 IP"文本 + 仅 1 个复制按钮

**回归覆盖**:原有 5 个 test 全部继续通过(无行为变更)。

---

## 6. 验收清单

- [ ] `SharePopover.tsx` 在多 IP / 单 IP / 空 IP / 空 session 四态下表现符合 §2
- [ ] QR 内容指向 `/m?sid=<sid>`,且包含 sessionId 完整值(非截断)
- [ ] 测试文件新增 3 个 case,全部通过
- [ ] 原 5 个 case 全部通过(无回归)
- [ ] `pnpm --filter @zn-ai/zai test` 全部绿
- [ ] `pnpm --filter @zn-ai/zai typecheck` 全部绿
- [ ] 无新增 npm 依赖(`bun.lock` / `pnpm-lock.yaml` 无 diff)

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| antd QRCode 在 jsdom 渲染失败 | 测试用 mock stub 替换;运行时浏览器支持良好(antd 已稳定) |
| QRCode 体积影响 popover 弹出性能 | antd QRCode canvas 在 happy-dom 单次 < 5ms,无明显影响 |
| 暗色主题下 QR 不清晰(用户已知悉) | 本期不做;后续若反馈多,加白底 wrapper |

回滚方式:`git revert <commit>` 即可,改动集中在单文件 + 单测试文件。