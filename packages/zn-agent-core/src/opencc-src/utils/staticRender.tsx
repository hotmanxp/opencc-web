// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect } from 'react';
import { PassThrough } from 'stream';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { render, useApp } from '../ink.js';

// This is a workaround for the fact that Ink doesn't support multiple <Static>
// components in the same render tree. Instead of using a <Static> we just render
// the component to a string and then print it to stdout

/**
 * Wrapper component that signals when rendering is complete.
 * Uses useEffect to call onRenderComplete after the component mounts.
 * This triggers the unmount in renderToAnsiString.
 */
function RenderOnceAndExit({ children, onComplete }: { children: React.ReactNode; onComplete: () => void }) {
  const $ = _c(2);

  useEffect(() => {
    // Signal that rendering is complete - don't unmount here, just signal
    // The unmount will be done by the caller via instance.unmount()
    onComplete();
  }, []);

  let t1;
  if ($[0] !== children) {
    t1 = <>{children}</>;
    $[0] = children;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  return t1;
}

// DEC synchronized update markers used by terminals
const SYNC_START = '\x1B[?2026h';
const SYNC_END = '\x1B[?2026l';

/**
 * Extracts content from the first complete frame in Ink's output.
 * Ink with non-TTY stdout outputs multiple frames, each wrapped in DEC synchronized
 * update sequences ([?2026h ... [?2026l). We only want the first frame's content.
 */
function extractFirstFrame(output: string): string {
  const startIndex = output.indexOf(SYNC_START);
  if (startIndex === -1) return output;
  const contentStart = startIndex + SYNC_START.length;
  const endIndex = output.indexOf(SYNC_END, contentStart);
  if (endIndex === -1) return output;
  return output.slice(contentStart, endIndex);
}

/**
 * Renders a React node to a string with ANSI escape codes (for terminal output).
 */
export function renderToAnsiString(node: React.ReactNode, columns?: number): Promise<string> {
  return new Promise(async resolve => {
    let output = '';
    let completed = false;

    // Capture all writes. Set .columns so Ink (ink.tsx:~165) picks up a
    // chosen width instead of PassThrough's undefined → 80 fallback —
    // useful for rendering at terminal width for file dumps that should
    // match what the user sees on screen.
    const stream = new PassThrough();
    if (columns !== undefined) {
      (stream as unknown as { columns: number }).columns = columns;
    }
    stream.on('data', chunk => {
      output += chunk.toString();
    });

    // Signal when rendering is complete - this triggers unmount
    const onComplete = () => {
      if (!completed) {
        completed = true;
        // Use setTimeout to ensure we don't unmount during render
        setTimeout(() => unmount(), 0);
      }
    };

    // Render the component wrapped in RenderOnceAndExit
    // Non-TTY stdout (PassThrough) gives full-frame output instead of diffs
    const instance = await render(<RenderOnceAndExit onComplete={onComplete}>{node}</RenderOnceAndExit>, {
      stdout: stream as unknown as NodeJS.WriteStream,
      patchConsole: false
    });

    const unmount = () => {
      instance.unmount();
    };

    // Wait for the component to signal completion, with a timeout guard so
    // tests never hang indefinitely if a render error prevents exit().
    await Promise.race([
      instance.waitUntilExit(),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);

    // Extract only the first frame's content to avoid duplication
    // (Ink outputs multiple frames in non-TTY mode)
    resolve(extractFirstFrame(output));
  });
}

/**
 * Renders a React node to a plain text string (ANSI codes stripped).
 */
export async function renderToString(node: React.ReactNode, columns?: number): Promise<string> {
  const output = await renderToAnsiString(node, columns);
  return stripAnsi(output);
}
