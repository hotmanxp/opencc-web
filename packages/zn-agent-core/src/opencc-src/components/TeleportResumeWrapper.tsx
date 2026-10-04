// @ts-nocheck
import type { TeleportRemoteResponse } from 'src/utils/conversationRecovery.js';
import { type TeleportSource } from '../hooks/useTeleportResume.js'
interface TeleportResumeWrapperProps {
  onComplete: (result: TeleportRemoteResponse) => void;
  onCancel: () => void;
  onError?: (error: string, formattedMessage?: string) => void;
  isEmbedded?: boolean;
  source: TeleportSource;
}

/**
 * Wrapper component that manages the full teleport resume flow,
 * including session selection, loading state, and error handling
 */
export function TeleportResumeWrapper(t0) {
  return null;
}
