import { describe, expect, test } from 'bun:test';
import { FileEditTool } from './FileEditTool.ts';

describe('FileEditTool description', () => {
  test('matches upstream 2.1.177 one-liner', async () => {
    const description = await (
      FileEditTool.description as unknown as () => Promise<string>
    )();
    expect(description).toBe('Performs exact string replacements in files.');
  });
});