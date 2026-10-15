/**
 * AA (Agents Anywhere) Settings page — Tab in /manage.
 *
 * Renders the user-facing AA integration UI:
 *   - Status badge (disabled / unpaired / pairing / connecting / connected / reconnecting)
 *   - Connector info card (server URL, connector id, paired-at) when paired
 *   - Pairing flow when unpaired: form → 8-digit code → wait → success
 *   - Cancel button for in-flight pairing
 *   - Live reconnection counter when reconnecting
 *
 * Architecture notes:
 *   - Pure UI / network logic — no zustand store needed; AA-specific
 *     state is small enough to live in useState.
 *   - Polls /api/aa/status while pairing in flight (and while reconnecting
 *     to keep the counter live).
 *   - Token redacted server-side; this page never sees cxt_*.
 *
 * Disabled state: when zai started without `--aa`, all backend routes
 * return 503 with `aa_disabled`. The page renders nothing at all — the AA
 * config surface (this tab, the per-instance AA switch, the page itself)
 * is only meant to exist on a process that actually has the AA bridge on.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  PlugIcon,
  RefreshCwIcon,
  CopyIcon,
  CheckIcon,
} from 'lucide-react';
import { aaApi, type AaConnectionState, type AaConfigPublic } from '../lib/aaApi';

const { Title, Text, Paragraph } = Typography;

// ─── Status colors ────────────────────────────────────────────────────────

const STATE_COLORS: Record<AaConnectionState, string> = {
  disabled: 'default',
  unpaired: 'warning',
  uninitialized: 'processing',
  idle: 'default',
  connecting: 'processing',
  connected: 'success',
  reconnecting: 'warning',
  closed: 'error',
};

const STATE_LABELS: Record<AaConnectionState, string> = {
  disabled: 'Disabled',
  unpaired: 'Not paired',
  uninitialized: 'Paired, initializing…',
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

// ─── Component ────────────────────────────────────────────────────────────

export default function AASettings() {
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<AaConnectionState>('disabled');
  const [config, setConfig] = useState<AaConfigPublic | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  // Pairing UI state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [pairingServerUrl, setPairingServerUrl] = useState<string>('https://web.agents-anywhere.com');
  const [pairingInProgress, setPairingInProgress] = useState(false);
  const [form] = Form.useForm();

  const pollRef = useRef<number | null>(null);

  // ─── Polling loop ─────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const result = await aaApi.getStatus();
      if (cancelled) return;
      if (result.ok) {
        const s = result.data;
        setState(s.status);
        setConfig(s.config ?? null);
        setLastError(s.connection?.lastError ?? null);
        setReconnectAttempts(s.connection?.reconnectAttempts ?? 0);
        setLoading(false);
        // `disabled` = 本次进程没带 `--aa`,它只能靠重启进程改变。停掉轮询,
        // 页面本身也返回 null(见下),没必要再每 5s 打一次 /api/aa/status。
        if (s.status === 'disabled') return;
        // Schedule next tick. Shorter interval while pairing or reconnecting
        // so user sees live updates; longer when stable.
        const fast = s.status === 'reconnecting' || pairingCode != null;
        pollRef.current = window.setTimeout(tick, fast ? 1_500 : 5_000);
      } else {
        setLoading(false);
        pollRef.current = window.setTimeout(tick, 5_000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (pollRef.current != null) clearTimeout(pollRef.current);
    };
  }, [pairingCode]);

  // ─── Actions ──────────────────────────────────────────────────────────

  const handleStartPairing = async () => {
    const url = form.getFieldValue('serverUrl') as string | undefined;
    if (!url) {
      message.error('请填写 AA 服务器地址');
      return;
    }
    setPairingInProgress(true);
    const result = await aaApi.startPairing(url);
    setPairingInProgress(false);
    if (!result.ok) {
      const err = (result.error as { body?: { error?: { message?: string } } })?.body?.error?.message;
      message.error(err ?? '启动配对失败');
      return;
    }
    const data = result.data;
    if (data.status === 'pending' && data.code && data.expiresAt) {
      setPairingCode(data.code);
      setPairingExpiresAt(data.expiresAt);
      message.success('已生成配对码,请在 AA Web 输入');
    } else {
      message.warning('意外的响应:' + JSON.stringify(data));
    }
  };

  const handlePollOnce = async () => {
    const result = await aaApi.pollPairing();
    if (!result.ok) {
      const err = (result.error as { body?: { error?: { message?: string } } })?.body?.error?.message;
      message.error(err ?? '轮询失败');
      return;
    }
    const data = result.data;
    if (data.status === 'claimed') {
      setPairingCode(null);
      setPairingExpiresAt(null);
      message.success('配对成功!AA 已连接');
      // Status will refresh on next tick; force a refresh now:
      const statusResult = await aaApi.getStatus();
      if (statusResult.ok) {
        setState(statusResult.data.status);
        setConfig(statusResult.data.config ?? null);
      }
    } else if (data.status === 'expired') {
      setPairingCode(null);
      setPairingExpiresAt(null);
      message.warning('配对码已过期,请重新启动');
    } else if (data.status === 'cancelled') {
      setPairingCode(null);
      setPairingExpiresAt(null);
    }
  };

  const handleCancelPairing = async () => {
    await aaApi.cancelPairing();
    setPairingCode(null);
    setPairingExpiresAt(null);
    message.info('配对已取消');
  };

  const handleCopyCode = () => {
    if (!pairingCode) return;
    void navigator.clipboard.writeText(pairingCode).then(
      () => message.success('已复制配对码'),
      () => message.error('复制失败'),
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Spin />
      </div>
    );
  }

  // 没带 `--aa` 启动:整页不渲染。AA 配置入口在 /manage(「AA 桥」tab)和
  // 实例管理(每行 AA 开关)都已按同一个开关藏掉,这里只是兜底 —— 万一有人
  // 停在旧书签 /manage?tab=aa,也不会看到一页「请重启加 --aa」的空提示。
  if (state === 'disabled') return null;

  return (
    <div className="max-w-3xl" data-testid="aa-settings">
      <Title level={3} className="flex items-center gap-2">
        <PlugIcon size={20} /> Agents Anywhere
      </Title>
      <Paragraph type="secondary">
        将此 zai 接入 Agents Anywhere(AA)云,手机端 AA app 即可看到所有会话、审批、远程操作。
        启用方式:zai 启动时加 <Text code>--aa</Text> flag。
      </Paragraph>

      {/* Status card */}
      <Card className="mb-4">
        <Space direction="vertical" size="middle" className="w-full">
          <div className="flex items-center gap-3">
            <Text strong>状态:</Text>
            <Tag color={STATE_COLORS[state]}>{STATE_LABELS[state]}</Tag>
            {state === 'reconnecting' && reconnectAttempts > 0 && (
              <Text type="secondary">第 {reconnectAttempts} 次重试</Text>
            )}
            <Button
              size="small"
              icon={<RefreshCwIcon size={14} />}
              onClick={async () => {
                const r = await aaApi.getStatus();
                if (r.ok) {
                  setState(r.data.status);
                  setConfig(r.data.config ?? null);
                  setLastError(r.data.connection?.lastError ?? null);
                  setReconnectAttempts(r.data.connection?.reconnectAttempts ?? 0);
                }
              }}
            >
              刷新
            </Button>
          </div>

          {state === 'unpaired' && !pairingCode && (
            <Form form={form} layout="vertical" initialValues={{ serverUrl: pairingServerUrl }}>
              <Form.Item
                name="serverUrl"
                label="AA 服务器地址"
                rules={[{ required: true, type: 'url', message: '请输入有效 URL' }]}
              >
                <Input
                  placeholder="https://web.agents-anywhere.com"
                  disabled={pairingInProgress}
                />
              </Form.Item>
              <Button
                type="primary"
                onClick={handleStartPairing}
                loading={pairingInProgress}
                icon={<PlugIcon size={14} />}
              >
                启动配对
              </Button>
            </Form>
          )}

          {pairingCode && (
            <Alert
              type="warning"
              showIcon
              message={
                <Space>
                  <Text>配对码(在 AA Web 「添加设备」页面输入)</Text>
                </Space>
              }
              description={
                <Space direction="vertical" className="w-full">
                  <Space size="middle">
                    <Text code style={{ fontSize: 24, letterSpacing: 4 }}>{pairingCode}</Text>
                    <Button
                      icon={<CopyIcon size={14} />}
                      onClick={handleCopyCode}
                      size="small"
                    >
                      复制
                    </Button>
                    <Button
                      type="primary"
                      onClick={handlePollOnce}
                      size="small"
                      icon={<CheckIcon size={14} />}
                    >
                      我已输入,立即检查
                    </Button>
                    <Button onClick={handleCancelPairing} size="small">取消</Button>
                  </Space>
                  {pairingExpiresAt && (
                    <Text type="secondary">
                      过期时间:{new Date(pairingExpiresAt).toLocaleString()}
                    </Text>
                  )}
                </Space>
              }
            />
          )}

          {config && (
            <Card type="inner" title="Connector 信息" size="small">
              <Space direction="vertical" size="small" className="w-full">
                <div>
                  <Text type="secondary">服务器:</Text> <Text code>{config.serverUrl}</Text>
                </div>
                <div>
                  <Text type="secondary">Connector ID:</Text> <Text code>{config.connectorId}</Text>
                </div>
                <div>
                  <Text type="secondary">名称:</Text> {config.connectorName}
                </div>
                <div>
                  <Text type="secondary">配对时间:</Text> {new Date(config.pairedAt).toLocaleString()}
                </div>
                {config.deviceOs && (
                  <div>
                    <Text type="secondary">系统:</Text> {config.deviceOs}
                  </div>
                )}
              </Space>
            </Card>
          )}

          {lastError && (
            <Alert type="error" showIcon message="最近错误" description={lastError} />
          )}
        </Space>
      </Card>

      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        提示:启动 zai 时加 <Text code>--aa</Text> 后,InstanceSupervisor 派生的子实例也会带上
        <Text code>--aa</Text>,子实例的事件会自动推送到 AA 服务器。
      </Paragraph>
    </div>
  );
}
