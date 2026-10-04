// @ts-nocheck
import { mkdir, writeFile } from 'fs/promises';
import { marked, type Tokens } from 'marked';
import { tmpdir } from 'os';
import { join } from 'path';
import React, { useRef } from 'react';
import { stringWidth } from '../../ink/stringWidth.js';
import { setClipboard } from '../../ink/termio/osc.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { AssistantMessage, Message } from '../../types/message.js';
import { extractTextContent, stripPromptXMLTags } from '../../utils/messages.js';
import { countCharInString } from '../../utils/stringUtils.js';
const COPY_DIR = join(tmpdir(), 'claude');
const RESPONSE_FILENAME = 'response.md';
const MAX_LOOKBACK = 20;
type CodeBlock = {
  code: string;
  lang: string | undefined;
};
function extractCodeBlocks(markdown: string): CodeBlock[] {
  const tokens = marked.lexer(stripPromptXMLTags(markdown));
  const blocks: CodeBlock[] = [];
  for (const token of tokens) {
    if (token.type === 'code') {
      const codeToken = token as Tokens.Code;
      blocks.push({
        code: codeToken.text,
        lang: codeToken.lang
      });
    }
  }
  return blocks;
}

/**
 * Walk messages newest-first, returning text from assistant messages that
 * actually said something (skips tool-use-only turns and API errors).
 * Index 0 = latest, 1 = second-to-latest, etc. Caps at MAX_LOOKBACK.
 */
export function collectRecentAssistantTexts(messages: Message[]): string[] {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < MAX_LOOKBACK; i--) {
    const msg = messages[i];
    if (msg?.type !== 'assistant' || (msg as AssistantMessage).isApiErrorMessage) continue;
    const content = (msg as AssistantMessage).message.content;
    if (!Array.isArray(content)) continue;
    const text = extractTextContent(content, '\n\n');
    if (text) texts.push(text);
  }
  return texts;
}
export function fileExtension(lang: string | undefined): string {
  if (lang) {
    // Sanitize to prevent path traversal (e.g. ```../../etc/passwd)
    // Language identifiers are alphanumeric: python, tsx, jsonc, etc.
    const sanitized = lang.replace(/[^a-zA-Z0-9]/g, '');
    if (sanitized && sanitized !== 'plaintext') {
      return `.${sanitized}`;
    }
  }
  return '.txt';
}
async function writeToFile(text: string, filename: string): Promise<string> {
  const filePath = join(COPY_DIR, filename);
  await mkdir(COPY_DIR, {
    recursive: true
  });
  await writeFile(filePath, text, 'utf-8');
  return filePath;
}
async function copyOrWriteToFile(text: string, filename: string): Promise<string> {
  const raw = await setClipboard(text);
  if (raw) process.stdout.write(raw);
  const lineCount = countCharInString(text, '\n') + 1;
  const charCount = text.length;
  // Also write to a temp file — clipboard paths are best-effort (OSC 52 needs
  // terminal support), so the file provides a reliable fallback.
  try {
    const filePath = await writeToFile(text, filename);
    return `Copied to clipboard (${charCount} characters, ${lineCount} lines)\nAlso written to ${filePath}`;
  } catch {
    return `Copied to clipboard (${charCount} characters, ${lineCount} lines)`;
  }
}
function truncateLine(text: string, maxLen: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  if (stringWidth(firstLine) <= maxLen) {
    return firstLine;
  }
  let result = '';
  let width = 0;
  const targetWidth = maxLen - 1;
  for (const char of firstLine) {
    const charWidth = stringWidth(char);
    if (width + charWidth > targetWidth) break;
    result += char;
    width += charWidth;
  }
  return result + '\u2026';
}
function CopyPicker(t0) {
  return null;
}
function _temp2(c) {
  return {
    ...c,
    copyFullResponse: true
  };
}
function _temp(block, index) {
  const blockLines = countCharInString(block.code, "\n") + 1;
  return {
    label: truncateLine(block.code, 60),
    value: index,
    description: [block.lang, blockLines > 1 ? `${blockLines} lines` : undefined].filter(Boolean).join(", ") || undefined
  };
}
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  return Promise.resolve(null);
};
