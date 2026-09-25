import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Modal, Spin, Tag } from 'antd';
import { apiRpc } from '../lib/api';
import type { McpStatusResponse } from '../../../shared/rpc.js';

/**
 * 设置页底部的「MCP 服务器」入口 + 状态弹窗。
 *
 * 背景:headless runtime 的 MCP 连接是 boot 期后台异步做的
 * (createOpenccRuntime-impl.ts 的 `connectMcp: false` 路径),两次退避重试
 * (5s / 15s)都失败后,**该进程在重启前不会再有 MCP 工具** —— 而过去这件事
 * 只有 console.warn,用户看到的是"agent 能聊但少了一批工具",既不知道原因
 * 也没有补救入口。这里把它变成可见 + 可重连。
 *
 * 视觉权重与相邻的「微信机器人」入口一致(底部小链接行 + 状态 Tag),
 * 状态拉取只在 drawer 打开时发生一次,失败静默(旧后端 / runtime 未就绪时
 * `/api/mcp/status` 返回 503,不应打扰设置面板)。
 */

/** server 状态 → Tag 文案(与服务端 type 取值对齐)。 */
const SERVER_TYPE_LABEL: Record<string, string> = {
  connected: '已连接',
  failed: '连接失败',
  'needs-auth': '需要授权',
  pending: '连接中',
};

const SERVER_TYPE_COLOR: Record<string, string> = {
  connected: 'green',
  failed: 'red',
  'needs-auth': 'orange',
  pending: 'blue',
};

export default function McpServersSection({ drawerOpen }: { drawerOpen: boolean }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [status, setStatus] = useState<McpStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiRpc.mcp.status.get());
    } catch {
      // runtime 未 init / 旧版后端返回 503 —— 保持上一次状态,不弹错。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await apiRpc.mcp.status.get();
        if (!cancelled) setStatus(next);
      } catch {
        // 静默,同上
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drawerOpen]);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    try {
      // 服务端内含 5s + 15s 退避重试,最坏 ~20s,所以按钮要一直转。
      setStatus(await apiRpc.mcp.reconnect.post(undefined));
    } catch {
      // 失败后拉一次最新状态,让用户看到实际结果而不是停在旧快照
      await refresh();
    } finally {
      setReconnecting(false);
    }
  }, [refresh]);

  const failure = status?.lastConnectFailure ?? null;
  const servers = status?.servers ?? [];
  const connectedCount = servers.filter((s) => s.type === 'connected').length;

  const summaryTag = (() => {
    if (!status) return null;
    if (status.connecting) {
      return <Tag color="blue" className="!m-0 !text-[10px] !leading-[16px] !px-[6px]">连接中</Tag>;
    }
    if (failure) {
      return <Tag color="red" className="!m-0 !text-[10px] !leading-[16px] !px-[6px]">{failure.failed} 个失败</Tag>;
    }
    if (connectedCount > 0) {
      return <Tag className="!m-0 !text-[10px] !leading-[16px] !px-[6px]">{connectedCount} 个已连接</Tag>;
    }
    return null;
  })();

  return (
    <>
      <div
        data-testid="settings-mcp-section"
        className="mt-4 pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between"
      >
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          data-testid="open-mcp-servers"
          className="text-[11px] text-[var(--text-dim-45)] hover:text-[var(--text)] cursor-pointer bg-transparent border-none p-0"
        >
          MCP 服务器
        </button>
        {summaryTag}
      </div>

      <Modal
        open={modalOpen}
        title="MCP 服务器"
        onCancel={() => setModalOpen(false)}
        width={560}
        footer={[
          <Button key="refresh" onClick={() => void refresh()} loading={loading} data-testid="mcp-refresh">
            刷新
          </Button>,
          <Button
            key="reconnect"
            type="primary"
            onClick={() => void handleReconnect()}
            loading={reconnecting}
            data-testid="mcp-reconnect"
          >
            重新连接
          </Button>,
          <Button key="close" onClick={() => setModalOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        {failure && (
          <Alert
            type="warning"
            showIcon
            className="mb-3"
            data-testid="mcp-failure-alert"
            message={`上次连接有 ${failure.failed}/${failure.total} 个 server 失败`}
            description={
              <>
                {failure.servers.length > 0 && <div>未连上:{failure.servers.join('、')}</div>}
                <div className="text-xs text-[var(--text-dim-45)]">
                  {new Date(failure.at).toLocaleString()} · 重试已耗尽,该进程重启前不会自动再连
                </div>
              </>
            }
          />
        )}

        {status?.connecting && (
          <div className="mb-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Spin size="small" /> 正在连接 MCP 服务器…
          </div>
        )}

        {servers.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span className="text-xs text-[var(--text-dim-45)]">
                没有已配置的 MCP 服务器(或尚未开始连接)
              </span>
            }
          />
        ) : (
          <div className="flex flex-col gap-2" data-testid="mcp-server-list">
            {servers.map((s) => (
              <div
                key={s.name}
                data-testid={`mcp-server-${s.name}`}
                className="rounded-md border border-[var(--border-subtle)] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--text)]">{s.name}</span>
                  <Tag color={SERVER_TYPE_COLOR[s.type] ?? 'default'} className="!m-0">
                    {SERVER_TYPE_LABEL[s.type] ?? s.type}
                  </Tag>
                </div>
                <div className="mt-1 text-xs text-[var(--text-dim-45)]">
                  {s.toolCount} 个工具
                  {s.commandCount > 0 ? ` · ${s.commandCount} 个命令` : ''}
                  {s.error ? ` · ${s.error}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}

        {status?.commands && status.commands.length > 0 && (
          <div className="mt-3 text-xs text-[var(--text-dim-45)]">
            已注册 {status.commands.length} 个 MCP 命令(在输入框敲 <code>/</code> 可搜索)
          </div>
        )}
      </Modal>
    </>
  );
}