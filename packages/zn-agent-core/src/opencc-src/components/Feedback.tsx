import axios from 'axios';
import { readFile, stat } from 'fs/promises';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../commands.js';
import { queryHaiku } from '../services/api/claude.js';
import { startsWithApiErrorPrefix } from '../services/api/errors.js';
import type { Message } from '../types/message.js';
import { checkAndRefreshOAuthTokenIfNeeded } from '../utils/auth.js';
import { logForDebugging } from '../utils/debug.js';
import { env } from '../utils/env.js';
import { getAuthHeaders, getUserAgent } from '../utils/http.js';
import { getInMemoryErrors, logError } from '../utils/log.js';
import { getAPIProvider } from '../utils/model/providers.js';
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js';
import { jsonRedactor, redactSensitiveInfo } from '../utils/redaction.js'
import { getTranscriptPath, MAX_TRANSCRIPT_READ_BYTES } from '../utils/sessionStorage.js'
import { jsonStringify } from '../utils/slowOperations.js';
import { asSystemPrompt } from '../utils/systemPromptType.js';

// This value was determined experimentally by testing the URL length limit
const GITHUB_URL_LIMIT = 7250;
const GITHUB_ISSUES_REPO_URL = 'https://github.com/hotmanxp/opencc/issues';
type Props = {
  abortSignal: AbortSignal;
  messages: Message[];
  initialDescription?: string;
  onDone(result: string, options?: {
    display?: CommandResultDisplay;
  }): void;
  backgroundTasks?: {
    [taskId: string]: {
      type: string;
      identity?: {
        agentId: string;
      };
      messages?: Message[];
    };
  };
};
type Step = 'userInput' | 'consent' | 'submitting' | 'done';
type CompletionMode = 'submitted' | 'issue-draft';
type FeedbackData = {
  // latestAssistantMessageId is the message ID from the latest main model call
  latestAssistantMessageId: string | null;
  message_count: number;
  datetime: string;
  description: string;
  platform: string;
  gitRepo: boolean;
  version: string | null;
  transcript: Message[];
  subagentTranscripts?: {
    [agentId: string]: Message[];
  };
  rawTranscriptJsonl?: string;
};

// Get sanitized error logs with sensitive information redacted
function getSanitizedErrorLogs(): Array<{
  error?: string;
  timestamp?: string;
}> {
  // Sanitize error logs to remove any API keys
  return getInMemoryErrors().map(errorInfo => {
    // Create a copy of the error info to avoid modifying the original
    const errorCopy = {
      ...errorInfo
    } as {
      error?: string;
      timestamp?: string;
    };

    // Sanitize error if present and is a string
    if (errorCopy && typeof errorCopy.error === 'string') {
      errorCopy.error = redactSensitiveInfo(errorCopy.error);
    }
    return errorCopy;
  });
}
async function loadRawTranscriptJsonl(): Promise<string | null> {
  try {
    const transcriptPath = getTranscriptPath();
    const {
      size
    } = await stat(transcriptPath);
    if (size > MAX_TRANSCRIPT_READ_BYTES) {
      logForDebugging(`Skipping raw transcript read: file too large (${size} bytes)`, {
        level: 'warn'
      });
      return null;
    }
    return await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}
export function Feedback({
  abortSignal,
  messages,
  initialDescription,
  onDone,
  backgroundTasks = {}
}: Props): React.ReactNode | null {
  return null;
}
export function createGitHubIssueUrl(feedbackId: string, title: string, description: string, errors: Array<{
  error?: string;
  timestamp?: string;
}>): string {
  const sanitizedTitle = redactSensitiveInfo(title);
  const sanitizedDescription = redactSensitiveInfo(description);
  const feedbackIdLine = feedbackId ? `- Feedback ID: ${feedbackId}\n` : '';
  const bodyPrefix = `**Bug Description**\n${sanitizedDescription}\n\n` + `**Environment Info**\n` + `- Platform: ${env.platform}\n` + `- Terminal: ${env.terminal}\n` + `- Version: ${MACRO.VERSION || 'unknown'}\n` + feedbackIdLine + `\n**Errors**\n\`\`\`json\n`;
  const errorSuffix = `\n\`\`\`\n`;
  const errorsJson = jsonStringify(errors);
  const baseUrl = `${GITHUB_ISSUES_REPO_URL}/new?title=${encodeURIComponent(sanitizedTitle)}&labels=user-reported,bug&body=`;
  const truncationNote = `\n**Note:** Content was truncated.\n`;
  const encodedPrefix = encodeURIComponent(bodyPrefix);
  const encodedSuffix = encodeURIComponent(errorSuffix);
  const encodedNote = encodeURIComponent(truncationNote);
  const encodedErrors = encodeURIComponent(errorsJson);

  // Calculate space available for errors
  const spaceForErrors = GITHUB_URL_LIMIT - baseUrl.length - encodedPrefix.length - encodedSuffix.length - encodedNote.length;

  // If description alone exceeds limit, truncate everything
  if (spaceForErrors <= 0) {
    const ellipsis = encodeURIComponent('…');
    const buffer = 50; // Extra safety margin
    const maxEncodedLength = GITHUB_URL_LIMIT - baseUrl.length - ellipsis.length - encodedNote.length - buffer;
    const fullBody = bodyPrefix + errorsJson + errorSuffix;
    let encodedFullBody = encodeURIComponent(fullBody);
    if (encodedFullBody.length > maxEncodedLength) {
      encodedFullBody = encodedFullBody.slice(0, maxEncodedLength);
      // Don't cut in middle of %XX sequence
      const lastPercent = encodedFullBody.lastIndexOf('%');
      if (lastPercent >= encodedFullBody.length - 2) {
        encodedFullBody = encodedFullBody.slice(0, lastPercent);
      }
    }
    return baseUrl + encodedFullBody + ellipsis + encodedNote;
  }

  // If errors fit, no truncation needed
  if (encodedErrors.length <= spaceForErrors) {
    return baseUrl + encodedPrefix + encodedErrors + encodedSuffix;
  }

  // Truncate errors to fit (prioritize keeping description)
  // Slice encoded errors directly, then trim to avoid cutting %XX sequences
  const ellipsis = encodeURIComponent('…');
  const buffer = 50; // Extra safety margin
  let truncatedEncodedErrors = encodedErrors.slice(0, spaceForErrors - ellipsis.length - buffer);
  // If we cut in middle of %XX, back up to before the %
  const lastPercent = truncatedEncodedErrors.lastIndexOf('%');
  if (lastPercent >= truncatedEncodedErrors.length - 2) {
    truncatedEncodedErrors = truncatedEncodedErrors.slice(0, lastPercent);
  }
  return baseUrl + encodedPrefix + truncatedEncodedErrors + ellipsis + encodedSuffix + encodedNote;
}
async function generateTitle(description: string, abortSignal: AbortSignal): Promise<string> {
  try {
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt(['Generate a concise, technical issue title (max 80 chars) for a public GitHub issue based on this bug report for OpenCC.', 'OpenCC is an agentic coding CLI based on the Anthropic API.', 'The title should:', '- Include the type of issue [Bug] or [Feature Request] as the first thing in the title', '- Be concise, specific and descriptive of the actual problem', '- Use technical terminology appropriate for a software issue', '- For error messages, extract the key error (e.g., "Missing Tool Result Block" rather than the full message)', '- Be direct and clear for developers to understand the problem', '- If you cannot determine a clear issue, use "Bug Report: [brief description]"', '- Any LLM API errors are from the Anthropic API, not from any other model provider', 'Your response will be directly used as the title of the Github issue, and as such should not contain any other commentary or explaination', 'Examples of good titles include: "[Bug] Auto-Compact triggers to soon", "[Bug] Anthropic API Error: Missing Tool Result Block", "[Bug] Error: Invalid Model Name for Opus"']),
      userPrompt: description,
      signal: abortSignal,
      options: {
        hasAppendSystemPrompt: false,
        toolChoice: undefined,
        isNonInteractiveSession: false,
        agents: [],
        querySource: 'feedback',
        mcpTools: []
      }
    });
    // @ts-expect-error content is string | ContentBlock[]
    const title = response.message.content[0]?.type === 'text' ? response.message.content[0].text : 'Bug Report';

    // Check if the title contains an API error message
    if (startsWithApiErrorPrefix(title)) {
      return createFallbackTitle(description);
    }
    return title;
  } catch (error) {
    // If there's any error in title generation, use a fallback title
    logError(error);
    return createFallbackTitle(description);
  }
}
function createFallbackTitle(description: string): string {
  // Create a safe fallback title based on the bug description

  // Try to extract a meaningful title from the first line
  const firstLine = description.split('\n')[0] || '';

  // If the first line is very short, use it directly
  if (firstLine.length <= 60 && firstLine.length > 5) {
    return firstLine;
  }

  // For longer descriptions, create a truncated version
  // Truncate at word boundaries when possible
  let truncated = firstLine.slice(0, 60);
  if (firstLine.length > 60) {
    // Find the last space before the 60 char limit
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 30) {
      // Only trim at word if we're not cutting too much
      truncated = truncated.slice(0, lastSpace);
    }
    truncated += '...';
  }
  return truncated.length < 10 ? 'Bug Report' : truncated;
}

// Helper function to sanitize and log errors without exposing API keys
function sanitizeAndLogError(err: unknown): void {
  if (err instanceof Error) {
    // Create a copy with potentially sensitive info redacted
    const safeError = new Error(redactSensitiveInfo(err.message));

    // Also redact the stack trace if present
    if (err.stack) {
      safeError.stack = redactSensitiveInfo(err.stack);
    }
    logError(safeError);
  } else {
    // For non-Error objects, convert to string and redact sensitive info
    const errorString = redactSensitiveInfo(String(err));
    logError(new Error(errorString));
  }
}
async function submitFeedback(data: FeedbackData, signal?: AbortSignal): Promise<{
  success: boolean;
  feedbackId?: string;
  isZdrOrg?: boolean;
  issueDraftOnly?: boolean;
}> {
  if (isEssentialTrafficOnly()) {
    return {
      success: false
    };
  }
  try {
    // Third-party providers should not post feedback to Anthropic, but they
    // should still reach the done state so users can open a GitHub issue draft.
    if (getAPIProvider() !== 'firstParty') {
      return {
        success: true,
        issueDraftOnly: true
      };
    }

    // Ensure OAuth token is fresh before getting auth headers
    // This prevents 401 errors from stale cached tokens
    await checkAndRefreshOAuthTokenIfNeeded();
    const authResult = getAuthHeaders();
    if (authResult.error) {
      return {
        success: false
      };
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers
    };
    const response = await axios.post('https://api.anthropic.com/api/claude_cli_feedback', {
      content: redactSensitiveInfo(jsonStringify(data, jsonRedactor))
    }, {
      headers,
      timeout: 30000,
      // 30 second timeout to prevent hanging
      signal
    });
    if (response.status === 200) {
      const result = response.data;
      if (result?.feedback_id) {
        return {
          success: true,
          feedbackId: result.feedback_id
        };
      }
      sanitizeAndLogError(new Error('Failed to submit feedback: request did not return feedback_id'));
      return {
        success: false
      };
    }
    sanitizeAndLogError(new Error('Failed to submit feedback:' + response.status));
    return {
      success: false
    };
  } catch (err) {
    // Handle cancellation/abort - don't log as error
    if (axios.isCancel(err)) {
      return {
        success: false
      };
    }
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      const errorData = err.response.data;
      if (errorData?.error?.type === 'permission_error' && errorData?.error?.message?.includes('Custom data retention settings')) {
        sanitizeAndLogError(new Error('Cannot submit feedback because custom data retention settings are enabled'));
        return {
          success: false,
          isZdrOrg: true
        };
      }
    }
    // Use our safe error logging function to avoid leaking API keys
    sanitizeAndLogError(err);
    return {
      success: false
    };
  }
}
