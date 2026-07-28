import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type { StreamClientEvent } from './SSETransport.js'

/**
 * Interface for bidirectional transport layers (WebSocket, SSE, etc.)
 * used by RemoteIO to communicate with the session ingress service.
 */
export interface Transport {
  connect(): Promise<void>
  close(): void
  write(message: StdoutMessage): Promise<void>

  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void

  /** Optional - only implemented by SSETransport for CCR event delivery tracking */
  setOnEvent?(callback: (event: StreamClientEvent) => void): void
  /** Optional - only implemented by WebSocketTransport for connection open events */
  setOnConnect?(callback: () => void): void

  isConnectedStatus(): boolean
  isClosedStatus(): boolean
  /** Optional - only implemented by WebSocketTransport for state inspection */
  getStateLabel?(): string
}
