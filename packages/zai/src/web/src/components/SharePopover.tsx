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
      <div style={{ fontSize: 12, color: 'var(--text-dim-45)', marginBottom: 8 }}>
        分享到 LAN — 点 Copy 把链接发给小伙伴
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
        <div style={{ fontSize: 12, color: 'var(--text-dim-45)' }}>
          扫码在手机上打开 <code>/m?sid={sessionId}</code>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim-65)' }}>
            首选: <code>{primaryIp}:{ctx.port}</code>
          </div>
          <Button
            size="small"
            icon={<CopyOutlined />}
            data-testid="share-copy-primary"
            onClick={() => void handleCopy(primaryIp)}
            aria-label="复制首选 URL"
          >
            复制
          </Button>
        </div>
      </div>

      {/* 其它可用 IP 分组: 仅在 ≥2 个 IP 时显示 */}
      {otherIps.length > 0 && (
        <>
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-dim-45)',
              borderTop: "1px solid var(--border-light)",
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
                    background: "var(--bg-faint-04)",
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
