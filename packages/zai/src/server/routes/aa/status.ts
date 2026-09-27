/**
 * AA status HTTP endpoint — read-only view of the live WS connection.
 *
 *   GET /api/aa/status  → { status: 'unpaired' | 'disabled' | 'connecting' | ... }
 *
 * Useful for the frontend Settings page to show "AA: connected" / "AA:
 * reconnecting (attempt 3)" / "AA: not paired — pair to enable". The
 * connection state comes from the singleton AaConnection via
 * getAaConnection(); a separate /api/aa/config endpoint already covers the
 * paired-vs-not question.
 */
import { Router, type IRouter } from 'express';
import { readAaConfig } from '../../services/aaClient/config.js';
import { isAaEnabled } from '../../services/aaClient/index.js';
import { getAaConnection } from '../../services/aaClient/connection.js';

const router: IRouter = Router();

router.get('/status', async (_req, res) => {
  if (!isAaEnabled()) {
    res.json({ status: 'disabled' });
    return;
  }
  let config: Awaited<ReturnType<typeof readAaConfig>> = null;
  try {
    config = await readAaConfig();
  } catch (err) {
    // Corrupt or schema-mismatched config: surface as paired-but-broken so
    // the UI can prompt the user to re-pair instead of crashing the route.
    res.json({
      status: 'config_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!config) {
    res.json({ status: 'unpaired' });
    return;
  }
  const conn = getAaConnection();
  if (!conn) {
    res.json({ status: 'uninitialized', config: redactConfig(config) });
    return;
  }
  const connStatus = conn.getStatus();
  res.json({
    status: connStatus.state,
    config: redactConfig(config),
    connection: {
      lastConnectedAt: connStatus.lastConnectedAt,
      lastDisconnectedAt: connStatus.lastDisconnectedAt,
      lastError: connStatus.lastError,
      reconnectAttempts: connStatus.reconnectAttempts,
    },
  });
});

function redactConfig(config: import('../../services/aaClient/index.js').AaConfig) {
  return {
    serverUrl: config.serverUrl,
    connectorId: config.connectorId,
    connectorName: config.connectorName,
    pairedAt: config.pairedAt,
    deviceOs: config.deviceOs,
    clientVersion: config.clientVersion,
    tokenPresent: true,
  };
}

export default router;
