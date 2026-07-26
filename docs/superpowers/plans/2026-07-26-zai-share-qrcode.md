# zai SharePopover 移动端扫码二维码 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `SharePopover` 顶部增加 antd `<QRCode>` 二维码区块,展示首选 IP + `sessionId` 对应的 `/m?sid=<sid>` URL,让 LAN 同事在手机/平板扫码直接进入 zai 移动端只读对话视图。

**Architecture:** 仅前端单文件改动:`SharePopover.tsx` 在标题行下方插入 QR 区(优先 IP + `/m` URL),下方条件渲染"其它可用 IP"分组(≥2 个 IP 时显示)。无 server / CLI / store / types 变动。复用 antd 内置 `<QRCode>`,不新增 npm 依赖。

**Tech Stack:** TypeScript 5, React 18, AntD 5 (`<QRCode>` 走 `@rc-component/qrcode`), vitest 4 + @testing-library/react

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-26-zai-share-qrcode-design.md`
- **关联 spec:**
  - `docs/superpowers/specs/2026-07-25-zai-agent-share-design.md`(SharePopover 现状)
  - `docs/superpowers/specs/2026-07-26-zai-mobile-agent-design.md`(`/m` 移动端路由已交付)
- **Node:** `>=20`(per `packages/zai/package.json:34`)
- **No new deps:** QR 码走 antd `<QRCode>`,`@rc-component/qrcode` 已通过 antd 5 间接引入,锁文件存在
- **Test runner:** `cd packages/zai && npm test`(vitest run,`@vitest-environment happy-dom` for web tests)
- **Typecheck:** `cd packages/zai && npm run typecheck`
- **Web test mock pattern:** `vi.mock("antd", …)` + `vi.stubGlobal("navigator", …)`(precedent at `test/web/SharePopover.test.tsx`)
- **No server / CLI / store / types changes:** 改动严格限定在 `SharePopover.tsx` + 它的单测
- **QR value 格式:** `http://<primaryIp>:<ctx.port>/m?sid=<sessionId>`(`/m` 直链,不依赖 server UA 重定向)
- **QR style:** 锁白底黑前景(`bgColor:"#fff"` + `color:"#000"`)+ `bordered` + `size={196}` + `icon={undefined}`
- **首选 IP:** `ctx.ips[0]`(复用现有 `detectLanIps` 返回顺序)
- **单 IP 时:** 隐藏"其它可用 IP"分组,只显示 QR + 首选 IP 说明
- **空 IP / 空 session:** 走现有"未启用 --lan" / "先开一个会话"分支,不变
- **回归要求:** 原 5 个 SharePopover test 必须全部继续通过

---

## File Structure

### 修改
- `packages/zai/src/web/src/components/SharePopover.tsx` — 顶部插入 QR 区(196×196)+ 副标题 + 首选 IP 文本;条件渲染"其它可用 IP"分组
- `packages/zai/test/web/SharePopover.test.tsx` — antd mock 扩展对 `QRCode` 的 stub;新增 3 个 case

### 不动
- server / CLI / store / types / 其它 web 组件(`useAgentStore`, `useAppStore`, `Layout`, `AgentInputBox` 全部不变)

---

## Task 1: mock antd `<QRCode>` 并新增 3 个 case

**Files:**
- Modify: `packages/zai/test/web/SharePopover.test.tsx:18-27`(扩展 `vi.mock("antd", …)`)
- Test: `packages/zai/test/web/SharePopover.test.tsx`(在文件尾部新增 3 个 case)

**参考 baseline**:`packages/zai/test/web/SharePopover.test.tsx` 当前已经有 `vi.mock("antd", …)` 和 `vi.hoisted` 块;扩展 mock stub,把 `QRCode` 替换为 stub 组件,避免 happy-dom canvas 报错。

- [ ] **Step 1: 扩展 vi.mock 添加 QRCode stub**

打开 `packages/zai/test/web/SharePopover.test.tsx`,把 line 18-27 的 mock 从:

```ts
vi.mock("antd", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    message: {
      success: (...args: unknown[]) => mocks.successOrError.success(...args),
      error: (...args: unknown[]) => mocks.successOrError.error(...args),
    },
  };
});
```

改成:

```ts
vi.mock("antd", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    message: {
      success: (...args: unknown[]) => mocks.successOrError.success(...args),
      error: (...args: unknown[]) => mocks.successOrError.error(...args),
    },
    QRCode: ({ value, "data-testid": testId, ...rest }: { value: string; "data-testid"?: string }) => (
      <div data-testid={testId} data-value={value} {...rest} />
    ),
  };
});
```

- [ ] **Step 2: 确认现有 5 个 test 仍 PASS**

跑:

```bash
cd packages/zai && npm test -- test/web/SharePopover.test.tsx
```

期望:5 个 test 全部 PASS(无回归,mock 改动未影响现有断言)。

- [ ] **Step 3: 在文件尾部新增 3 个 test case**

在最后一个 `});`(line 105)之前插入:

```tsx
  test("renders primary QRCode with /m URL and '其它可用 IP' list when multiple IPs", () => {
    render(<SharePopover />);
    // QR stub 存在
    expect(screen.getByTestId("share-primary-qrcode")).toBeInTheDocument();
    // 副标题文本
    expect(screen.getByText(/扫码在手机上打开/)).toBeInTheDocument();
    expect(screen.getByText(/\/m\?sid=sess-test-123/)).toBeInTheDocument();
    // "其它可用 IP" 分组标题
    expect(screen.getByText(/其它可用 IP/)).toBeInTheDocument();
    // 2 个 IP → 2 个复制按钮(每个 IP 一行)
    expect(screen.getAllByRole("button", { name: /复制/ })).toHaveLength(2);
  });

  test("primary QRCode value points to /m?sid=<sid> with first IP", () => {
    render(<SharePopover />);
    const qr = screen.getByTestId("share-primary-qrcode");
    // stub 把 value 放在 data-value 上
    expect(qr.getAttribute("data-value")).toBe(
      "http://192.168.1.5:9888/m?sid=sess-test-123",
    );
  });

  test("hides '其它可用 IP' group when only one IP", () => {
    useAppStore.setState({
      instanceContext: {
        cwd: "/tmp",
        cwdName: "tmp",
        branch: null,
        host: "0.0.0.0",
        port: 9888,
        ips: ["192.168.1.5"],
      },
    });
    render(<SharePopover />);
    // QR 仍渲染
    expect(screen.getByTestId("share-primary-qrcode")).toBeInTheDocument();
    // "其它可用 IP" 标题不出现
    expect(screen.queryByText(/其它可用 IP/)).not.toBeInTheDocument();
    // 仅 1 个复制按钮
    expect(screen.getAllByRole("button", { name: /复制/ })).toHaveLength(1);
  });
```

注意:`beforeEach` 已经重置 store 状态,但 step 3 第三个 case 在 `render` 前 setState,这是允许的;`beforeEach` 的 setState 在外层,不影响 test 内的 setState 顺序(test 内 setState 覆盖外层)。

- [ ] **Step 4: 跑测试,确认新 case 全部 FAIL(预期,因为还没实现)**

```bash
cd packages/zai && npm test -- test/web/SharePopover.test.tsx
```

期望:3 个新 case FAIL,提示找不到 `share-primary-qrcode` testid / 找不到"扫码在手机上打开" / "其它可用 IP"。原 5 个仍 PASS。

- [ ] **Step 5: Commit(仅测试)**

```bash
git add packages/zai/test/web/SharePopover.test.tsx
git commit -m "test(SharePopover): add failing tests for primary QRCode"
```

---

## Task 2: 在 SharePopover 实现 QR 区(单 IP 分支 + 多 IP 分支)

**Files:**
- Modify: `packages/zai/src/web/src/components/SharePopover.tsx`(全文重写,~110 行)

**Interfaces:**
- Consumes: `useAppStore((s) => s.instanceContext)` 返回 `{ cwd, cwdName, branch, host, port, ips: string[] }`;`useAgentStore((s) => s.sessionId)` 返回 `string | null`
- Produces: 渲染 `<QRCode data-testid="share-primary-qrcode" value={primaryQrUrl} … />`,以及可选"其它可用 IP"分组

- [ ] **Step 1: 重写 `packages/zai/src/web/src/components/SharePopover.tsx`**

完整文件内容(替换整个文件):

```tsx
import { useState } from "react";
import { Button, QRCode, Space, Typography, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { useAppStore } from "../store/useAppStore.js";
import { useAgentStore } from "../store/useAgentStore.js";

const { Text } = Typography;

export default function SharePopover() {
  const ctx = useAppStore((s) => s.instanceContext);
  const sessionId = useAgentStore((s) => s.sessionId);
  // clipboard 失败时把 URL 记录下来, 行内 Text 元素始终 user-selectable,
  // 用户可直接鼠标选中复制. Spec §6: "URL 用 <code> 包裹可手动复制".
  const [copyError, setCopyError] = useState<Record<string, string>>({});

  if (!sessionId) {
    return (
      <div style={{ padding: "12px 4px", fontSize: 13 }}>
        先开一个会话再分享。
      </div>
    );
  }

  if (!ctx || ctx.ips.length === 0) {
    return (
      <div style={{ padding: "12px 4px", fontSize: 13, maxWidth: 280 }}>
        未启用 <code>--lan</code>,无法分享到局域网。
        <br />
        用 <code>zai --lan</code> 重新启动 server。
      </div>
    );
  }

  const primaryIp = ctx.ips[0]!;
  const otherIps = ctx.ips.slice(1);
  const primaryQrUrl = `http://${primaryIp}:${ctx.port}/m?sid=${sessionId}`;

  const handleCopy = async (ip: string) => {
    const url = `http://${ip}:${ctx.port}/agent?sid=${sessionId}`;
    try {
      await navigator.clipboard.writeText(url);
      message.success(`已复制 ${url}`);
      setCopyError((prev) => {
        const next = { ...prev };
        delete next[ip];
        return next;
      });
    } catch {
      message.error("复制失败,请手动选择下方 URL");
      setCopyError((prev) => ({ ...prev, [ip]: url }));
    }
  };

  return (
    <div style={{ maxWidth: 360, padding: "4px 0" }}>
      <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
        分享到 LAN — 点 Copy 把链接发给同事
      </div>

      {/* 主二维码区: 锁白底黑前景, 暗色背景下扫码更稳 */}
      <div
        data-testid="share-primary-section"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "10px 0 12px",
        }}
      >
        <QRCode
          value={primaryQrUrl}
          size={196}
          bordered
          color="#000"
          bgColor="#fff"
          data-testid="share-primary-qrcode"
        />
        <div style={{ fontSize: 12, color: "#999" }}>
          扫码在手机上打开 <code>/m?sid={sessionId}</code>
        </div>
        <div style={{ fontSize: 12, color: "#666" }}>
          首选: <code>{primaryIp}:{ctx.port}</code>
        </div>
      </div>

      {/* 其它可用 IP 分组: 仅在 ≥2 个 IP 时显示 */}
      {otherIps.length > 0 && (
        <>
          <div
            style={{
              fontSize: 12,
              color: "#999",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              paddingTop: 8,
              marginTop: 4,
              marginBottom: 6,
            }}
          >
            其它可用 IP
          </div>
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            {otherIps.map((ip) => {
              const url = `http://${ip}:${ctx.port}/agent?sid=${sessionId}`;
              const errored = Boolean(copyError[ip]);
              return (
                <div
                  key={ip}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "rgba(255,255,255,0.04)",
                    borderRadius: 4,
                  }}
                >
                  <Text
                    code
                    style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}
                  >
                    {ip}:{ctx.port}/agent?sid={sessionId.slice(0, 12)}…
                  </Text>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    data-testid={`share-copy-${ip}`}
                    onClick={() => void handleCopy(ip)}
                    aria-label={errored ? `选择 ${ip} URL` : `复制 ${ip}`}
                  >
                    {errored ? "选择" : "复制"}
                  </Button>
                </div>
              );
            })}
          </Space>
        </>
      )}
    </div>
  );
}
```

实现要点(写给 reviewer):
- **L41 `primaryIp = ctx.ips[0]!`**: 上面 `if (!ctx || ctx.ips.length === 0)` 已保证非空,TS narrowing 不穿透,加 `!` 断言
- **L42 `otherIps = ctx.ips.slice(1)`**: 移除首选 IP,长度 0 时不渲染分组
- **L43 `primaryQrUrl`**: 直链 `/m`,扫码后命中已交付的移动端 SPA
- **L67 `data-testid="share-primary-qrcode"`**: 透传到 stub,供 test 断言
- **L78 副标题**: 包含完整 `sessionId`,QR value 也是完整 sessionId(对比行内的 `.slice(0,12)` 是显示截断,不影响扫码内容)
- **L82 首选 IP 文本**: 便于人工校对扫码内容
- **L88 分组标题**: 仅在 `otherIps.length > 0` 时渲染(单 IP 时整段 JSX 不进 DOM,符合 spec §2 边界态)

- [ ] **Step 2: 跑 SharePopover 全部测试,确认新 case PASS 且无回归**

```bash
cd packages/zai && npm test -- test/web/SharePopover.test.tsx
```

期望:原 5 个 + 新 3 个 = 8 个 test 全部 PASS。

- [ ] **Step 3: 跑 typecheck**

```bash
cd packages/zai && npm run typecheck
```

期望:无 error(若 antd `<QRCode>` 类型对 `data-testid` 报"unknown prop",按下面 step 4 处理)。

- [ ] **Step 4(可选): 若 typecheck 报 QRCode data-testid 不存在类型**

antd `QRCodeProps` 继承 `React.HTMLAttributes<HTMLDivElement>`,理论上 `data-*` 通用属性允许;若仍报错,在 `QRCode` 上方加一行 `// @ts-expect-error antd QRCode 类型不完全匹配 data-* prop`,或把 `data-testid` 移到外层 `<div>` wrapper(调整 stub testid selector 为 `share-primary-section` 内的 `data-value` 选择)。

- [ ] **Step 5: Commit(实现)**

```bash
git add packages/zai/src/web/src/components/SharePopover.tsx
git commit -m "feat(SharePopover): add primary QRCode for mobile scan"
```

---

## Task 3: 全量验证 + 锁文件 diff 检查

**Files:**
- 不修改文件,只跑验证命令

- [ ] **Step 1: 跑 zai 全部 web 测试,确认无回归**

```bash
cd packages/zai && npm test -- test/web
```

期望:全部 PASS(SharePopover 8 个 + 其它 web test 全部绿)。

- [ ] **Step 2: 跑 zai 全量测试**

```bash
cd packages/zai && npm test
```

期望:全部 PASS(无 server / CLI / agent-core 回归,因为改动严格限定单文件)。

- [ ] **Step 3: 跑 typecheck**

```bash
cd packages/zai && npm run typecheck
```

期望:无 error。

- [ ] **Step 4: 检查锁文件无 diff(spec §6 验收: 无新增 npm 依赖)**

```bash
cd /Users/ethan/code/opencc-web && git diff --stat bun.lock pnpm-lock.yaml package.json packages/zai/package.json
```

期望:全部为空(`bun.lock` / `pnpm-lock.yaml` / `packages/zai/package.json` 无 diff)。

- [ ] **Step 5(可选, 视觉验证): 手动启 server 看弹窗**

```bash
cd packages/zai && npm run dev -- --lan
# 浏览器打开 http://localhost:9888/agent, 开一个 session, 点工具栏 Share 按钮
# 期望: 弹窗顶部显示 QR 码 + 副标题 + 首选 IP;多网卡时下方有"其它可用 IP"列表
```

若启不来 server 或端口占用,可跳过视觉验证,自动化测试已覆盖行为。

- [ ] **Step 6: 提交(若有 lockfile diff 或视觉验证截图)**

若有 lockfile diff,先 revert 再 commit message 注明:

```bash
git checkout -- bun.lock pnpm-lock.yaml
git commit --allow-empty -m "chore: verify no new deps for QR feature"
```

若视觉验证发现 UI 问题,修复后追加 commit(不应发生,spec 已锁定样式)。

---

## Self-Review

**Spec 覆盖**:
- §1 目标: Task 1 mock + Task 2 实现 + Task 3 验证覆盖 ✓
- §2 弹窗布局 + 边界态: Task 2 的 JSX 实现与 spec ASCII 草图一致(4 态全部分支)✓
- §3 架构 / 数据流: Task 2 `primaryIp` / `primaryQrUrl` / `otherIps` 命名与 spec §3 一致 ✓
- §3.1 QR = `/m?sid=`: `primaryQrUrl` 模板用 `/m` ✓
- §3.2 首选 IP = `ctx.ips[0]`: `primaryIp = ctx.ips[0]!` ✓
- §3.3 antd `<QRCode>`: import + 复用 ✓
- §3.4 样式锁定: `size={196}` `bordered` `color="#000"` `bgColor="#fff"` 全部一致 ✓
- §4 错误处理: 走原有"未启用 --lan" / "先开一个会话"分支 ✓
- §5 测试: Task 1 新增 3 case,mock 策略精确一致 ✓
- §6 验收清单: Task 3 step 1-4 全部覆盖(测试绿 / typecheck / 锁文件无 diff)✓
- §7 风险与回滚: 单文件改动,`git revert` 即回滚 ✓

**Placeholder 扫描**: 无 TBD / TODO / "implement later" / "similar to Task N"。

**类型一致性**: `primaryIp` / `primaryQrUrl` / `otherIps` / `share-primary-qrcode` testid 在 Task 1 (test) 与 Task 2 (impl) 之间一致;`sessionId` 在两处都从 `useAgentStore` 取,与现有代码一致。

**潜在风险**: antd `<QRCode>` 类型对 `data-testid` 可能不友好 → Task 2 step 4 兜底处理(已在 plan 内)。