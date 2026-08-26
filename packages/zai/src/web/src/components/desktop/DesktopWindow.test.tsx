// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DesktopWindow from './DesktopWindow.js';
import { initWindows } from './windowMath.js';
import '@testing-library/jest-dom';

const V = { w: 1200, h: 800 };

function baseWin(over: Partial<ReturnType<typeof initWindows>[number]> = {}) {
  return { ...initWindows(V)[1]!, title: 'Agent · Office', ...over };
}

describe('DesktopWindow', () => {
  test('渲染标题与内容,minimized 时返回 null', () => {
    const { rerender } = render(
      <DesktopWindow win={baseWin()} active viewport={V} onFocus={() => {}} onMinimize={() => {}} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    expect(screen.getByText('Agent · Office')).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
    rerender(
      <DesktopWindow win={baseWin({ minimized: true })} active viewport={V} onFocus={() => {}} onMinimize={() => {}} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    expect(screen.queryByText('正文')).not.toBeInTheDocument();
  });

  test('双击标题栏触发 onToggleMax', () => {
    const onToggleMax = vi.fn();
    render(
      <DesktopWindow win={baseWin()} active viewport={V} onFocus={() => {}} onMinimize={() => {}} onToggleMax={onToggleMax} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    fireEvent.doubleClick(screen.getByText('Agent · Office'));
    expect(onToggleMax).toHaveBeenCalledTimes(1);
  });

  test('最小化按钮触发 onMinimize', () => {
    const onMinimize = vi.fn();
    render(
      <DesktopWindow win={baseWin()} active viewport={V} onFocus={() => {}} onMinimize={onMinimize} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    fireEvent.click(screen.getByLabelText('最小化'));
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });

  test('点击窗口触发 onFocus(置顶)', () => {
    const onFocus = vi.fn();
    render(
      <DesktopWindow win={baseWin()} active={false} viewport={V} onFocus={onFocus} onMinimize={() => {}} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    fireEvent.pointerDown(screen.getByRole('region'));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
