// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView } from './DiffView.js';

const SAMPLE = [
  'diff --git a/foo.ts b/foo.ts',
  'index 0000..1111 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,2 +1,2 @@',
  ' unchanged',
  '-old line',
  '+new line',
  '+another new',
].join('\n');

describe('DiffView', () => {
  it('renders empty state for empty diff', () => {
    render(<DiffView diff="" />);
    expect(screen.getByText(/没有差异/i)).toBeTruthy();
  });

  it('renders added lines', () => {
    render(<DiffView diff={SAMPLE} />);
    // The impl strips the leading +/- prefix into the gutter span, so the
    // content text is just the body. This matches the existing DiffBlock.tsx
    // precedent used by Edit/Write tool renderers in this codebase.
    expect(screen.getAllByText('new line').length).toBeGreaterThan(0);
    expect(screen.getAllByText('another new').length).toBeGreaterThan(0);
  });

  it('renders deleted lines', () => {
    render(<DiffView diff={SAMPLE} />);
    expect(screen.getAllByText('old line').length).toBeGreaterThan(0);
  });

  it('renders hunk header', () => {
    render(<DiffView diff={SAMPLE} />);
    expect(screen.getAllByText(/@@ -1,2 \+1,2 @@/).length).toBeGreaterThan(0);
  });
});