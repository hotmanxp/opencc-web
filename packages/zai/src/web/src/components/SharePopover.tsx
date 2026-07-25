import { useState } from "react";
import { Button, Space, Typography, message } from "antd";
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
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {ctx.ips.map((ip) => {
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
    </div>
  );
}