import { useEffect, useState, type RefObject } from 'react';

/**
 * Track the current height (px) of an element via ResizeObserver.
 * Returns the height as a number so callers can pass it to antd Tree's
 * `height` prop — without a numeric height, rc-virtual-list (used by
 * antd Tree when virtual !== false) sets no `maxHeight` / `overflowY`
 * on its inner holder, so the tree's content stretches its container
 * past the panel and the surrounding `overflow:auto` never gets a
 * chance to clip it.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Initial read; ResizeObserver fires on subsequent changes only.
    setHeight(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) setHeight(Math.round(h));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}