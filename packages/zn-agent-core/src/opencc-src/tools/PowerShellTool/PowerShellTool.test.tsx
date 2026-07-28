import { describe, expect, test } from 'bun:test';
import { PowerShellTool } from './PowerShellTool.js';

describe('PowerShellTool description', () => {
  test('default description matches upstream 2.1.177 sync (HYBRID: Windows-native preserved)', async () => {
    const description = await PowerShellTool.description({});
    expect(description).toBe(
      'Executes a PowerShell command. Working directory persists between commands; shell state does not. On Windows native, sandbox is unavailable. Set run_in_background: true for long-running commands.'
    );
  });

  test('description contains "PowerShell" and "sandbox"', async () => {
    const description = await PowerShellTool.description({});
    expect(description).toContain('PowerShell');
    expect(description).toContain('sandbox');
  });

  test('description preserves "On Windows native, sandbox is unavailable"', async () => {
    const description = await PowerShellTool.description({});
    expect(description).toContain('On Windows native, sandbox is unavailable');
  });
});
