// @ts-nocheck
import type { RefObject } from 'react';
import * as React from 'react';
import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import type { DOMElement } from '../ink/dom.js';
import type { MatchPosition } from '../ink/render-to-screen.js';
import type { RenderableMessage } from '../types/message.js';
import { ScrollChromeContext } from './FullscreenLayout.js';

// Rows of breathing room above the target when we scrollTo.
const HEADROOM = 3;
import { renderableSearchText } from '../utils/transcriptSearch.js';
import { type MessageActionsNav, type MessageActionsState, stripSystemReminders } from './messageActions.js'

// Fallback extractor: lower + cache here for callers without the
// Messages.tsx tool-lookup path (tests, static contexts). Messages.tsx
// provides its own lowering cache that also handles tool extractSearchText.
const fallbackLowerCache = new WeakMap<RenderableMessage, string>();
function defaultExtractSearchText(msg: RenderableMessage): string {
  const cached = fallbackLowerCache.get(msg);
  if (cached !== undefined) return cached;
  const lowered = renderableSearchText(msg);
  fallbackLowerCache.set(msg, lowered);
  return lowered;
}
export type StickyPrompt = {
  text: string;
  scrollTo: () => void;
}
// Click sets this — header HIDES but padding stays collapsed (0) so
// the content ❯ lands at screen row 0 instead of row 1. Cleared on
// the next sticky-prompt compute (user scrolls again).
| 'clicked';

/** Huge pasted prompts (cat file | claude) can be MBs. Header wraps into
 *  2 rows via overflow:hidden — this just bounds the React prop size. */
const STICKY_TEXT_CAP = 500;

/** Imperative handle for transcript navigation. Methods compute matches
 *  HERE (renderableMessages indices are only valid inside this component —
 *  Messages.tsx filters and reorders, REPL can't compute externally). */
export type JumpHandle = {
  jumpToIndex: (i: number) => void;
  setSearchQuery: (q: string) => void;
  nextMatch: () => void;
  prevMatch: () => void;
  /** Capture current scrollTop as the incsearch anchor. Typing jumps
   *  around as preview; 0-matches snaps back here. Enter/n/N never
   *  restore (they don't call setSearchQuery with empty). Next / call
   *  overwrites. */
  setAnchor: () => void;
  /** Warm the search-text cache by extracting every message's text.
   *  Returns elapsed ms, or 0 if already warm (subsequent / in same
   *  transcript session). Yields before work so the caller can paint
   *  "indexing…" first. Caller shows "indexed in Xms" on resolve. */
  warmSearchIndex: () => Promise<number>;
  /** Manual scroll (j/k/PgUp/wheel) exited the search context. Clear
   *  positions (yellow goes away, inverse highlights stay). Next n/N
   *  re-establishes via step()→jump(). Wired from ScrollKeybindingHandler's
   *  onScroll — only fires for keyboard/wheel, not programmatic scrollTo. */
  disarmSearch: () => void;
};
type Props = {
  messages: RenderableMessage[];
  scrollRef: RefObject<ScrollBoxHandle | null>;
  /** Invalidates heightCache on change — cached heights from a different
   *  width are wrong (text rewrap → black screen on scroll-up after widen). */
  columns: number;
  itemKey: (msg: RenderableMessage) => string;
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode;
  /** Fires when a message Box is clicked (toggle per-message verbose). */
  onItemClick?: (msg: RenderableMessage) => void;
  /** Per-item filter — suppress hover/click for messages where the verbose
   *  toggle does nothing (text, file edits, etc). Defaults to all-clickable. */
  isItemClickable?: (msg: RenderableMessage) => boolean;
  /** Expanded items get a persistent grey bg (not just on hover). */
  isItemExpanded?: (msg: RenderableMessage) => boolean;
  /** PRE-LOWERED search text. Messages.tsx caches the lowered result
   *  once at warm time so setSearchQuery's per-keystroke loop does
   *  only indexOf (zero toLowerCase alloc). Falls back to a lowering
   *  wrapper on renderableSearchText for callers without the cache. */
  extractSearchText?: (msg: RenderableMessage) => string;
  /** Enable the sticky-prompt tracker. StickyTracker writes via
   *  ScrollChromeContext (not a callback prop) so state lives in
   *  FullscreenLayout instead of REPL. */
  trackStickyPrompt?: boolean;
  selectedIndex?: number;
  /** Nav handle lives here because height measurement lives here. */
  cursorNavRef?: React.Ref<MessageActionsNav>;
  setCursor?: (c: MessageActionsState | null) => void;
  jumpRef?: RefObject<JumpHandle | null>;
  /** Fires when search matches change (query edit, n/N). current is
   *  1-based for "3/47" display; 0 means no matches. */
  onSearchMatchesChange?: (count: number, current: number) => void;
  /** Paint existing DOM subtree to fresh Screen, scan. Element from the
   *  main tree (all providers). Message-relative positions (row 0 = el
   *  top). Works for any height — closes the tall-message gap. */
  scanElement?: (el: DOMElement) => MatchPosition[];
  /** Position-based CURRENT highlight. Positions known upfront (from
   *  scanElement), navigation = index arithmetic + scrollTo. rowOffset
   *  = message's current screen-top; positions stay stable. */
  setPositions?: (state: {
    positions: MatchPosition[];
    rowOffset: number;
    currentIdx: number;
  } | null) => void;
};

/**
 * Returns the text of a real user prompt, or null for anything else.
 * "Real" = what the human typed: not tool results, not XML-wrapped payloads
 * (<bash-stdout>, <command-message>, <teammate-message>, etc.), not meta.
 *
 * Two shapes land here: NormalizedUserMessage (normal prompts) and
 * AttachmentMessage with type==='queued_command' (prompts sent mid-turn
 * while a tool was executing — they get drained as attachments on the
 * next turn, see query.ts:1410). Both render as ❯-prefixed UserTextMessage
 * in the UI so both should stick.
 *
 * Leading <system-reminder> blocks are stripped before checking — they get
 * prepended to the stored text for OpenCC's context (memory updates, auto
 * mode reminders) but aren't what the user typed. Without stripping, any
 * prompt that happened to get a reminder is rejected by the startsWith('<')
 * check. Shows up on `cc -c` resumes where memory-update reminders are dense.
 */
const promptTextCache = new WeakMap<RenderableMessage, string | null>();
function stickyPromptText(msg: RenderableMessage): string | null {
  // Cache keyed on message object — messages are append-only and don't
  // mutate, so a WeakMap hit is always valid. The walk (StickyTracker,
  // per-scroll-tick) calls this 5-50+ times with the SAME messages every
  // tick; the system-reminder strip allocates a fresh string on each
  // parse. WeakMap self-GCs on compaction/clear (messages[] replaced).
  const cached = promptTextCache.get(msg);
  if (cached !== undefined) return cached;
  const result = computeStickyPromptText(msg);
  promptTextCache.set(msg, result);
  return result;
}
function computeStickyPromptText(msg: RenderableMessage): string | null {
  let raw: string | null = null;
  if (msg.type === 'user') {
    if (msg.isMeta || msg.isVisibleInTranscriptOnly) return null;
    const block = msg.message.content[0];
    if (block?.type !== 'text') return null;
    raw = block.text;
  } else if (msg.type === 'attachment' && msg.attachment.type === 'queued_command' && msg.attachment.commandMode !== 'task-notification' && !msg.attachment.isMeta) {
    const p = msg.attachment.prompt;
    raw = typeof p === 'string' ? p : p.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
  }
  if (raw === null) return null;
  const t = stripSystemReminders(raw);
  if (t.startsWith('<') || t === '') return null;
  return t;
}

/**
 * Virtualized message list for fullscreen mode. Split from Messages.tsx so
 * useVirtualScroll is called unconditionally (rules-of-hooks) — Messages.tsx
 * conditionally renders either this or a plain .map().
 *
 * The wrapping <Box ref> is the measurement anchor — MessageRow doesn't take
 * a ref. Single-child column Box passes Yoga height through unchanged.
 */

// Item wrapper with stable click handlers. The per-item closures were the
// `operationNewArrowFunction` leafs → `FunctionExecutable::finalizeUnconditionally`
// GC cleanup (16% of GC time during fast scroll). 3 closures × 60 mounted ×
// 10 commits/sec = 1800 closures/sec. With stable onClickK/onEnterK/onLeaveK
// threaded via itemKey, the closures here are per-item-per-render but CHEAP
// (just wrap the stable callback with k bound) and don't close over msg/idx
// which lets JIT inline them. The bigger win is inside: MessageRow.memo
// bails for unchanged msgs, skipping marked.lexer + formatToken.
//
// NOT React.memo'd — renderItem captures changing state (cursor, selectedIdx,
// verbose). Memoing with a comparator that ignores renderItem would use a
// STALE closure on bail (wrong selection highlight, stale verbose). Including
// renderItem in the comparator defeats memo since it's fresh each render.
function VirtualItem(t0) {
  return null;
}
export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  itemKey,
  renderItem,
  onItemClick,
  isItemClickable,
  isItemExpanded,
  extractSearchText = defaultExtractSearchText,
  trackStickyPrompt,
  selectedIndex,
  cursorNavRef,
  setCursor,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions
}: Props): React.ReactNode | null {
  // Incremental key array. Streaming appends one message at a time; rebuilding
  // the full string array on every commit allocates O(n) per message (~1MB
  // churn at 27k messages). Append-only delta push when the prefix matches;
  // fall back to full rebuild on compaction, /clear, or itemKey change.
  return null;
}
const NOOP_UNSUB = () => {};

/**
 * Effect-only child that tracks the last user-prompt scrolled above the
 * viewport top and fires onChange when it changes.
 *
 * Rendered as a separate component (not a hook in VirtualMessageList) so it
 * can subscribe to scroll at FINER granularity than SCROLL_QUANTUM=40. The
 * list needs the coarse quantum to avoid per-wheel-tick Yoga relayouts; this
 * tracker is just a walk + comparison and can afford to run every tick. When
 * it re-renders alone, the list's reconciled output is unchanged (same props
 * from the parent's last commit) — no Yoga work. Without this split, the
 * header lags by ~one conversation turn (40 rows ≈ one prompt + response).
 *
 * firstVisible derivation: item Boxes are direct Yoga children of the
 * ScrollBox content wrapper (fragments collapse in the Ink DOM), so
 * yoga.getComputedTop is content-wrapper-relative — same coordinate space as
 * scrollTop. Compare against scrollTop + pendingDelta (the scroll TARGET —
 * scrollBy only sets pendingDelta, committed scrollTop lags). Walk backward
 * from the mount-range end; break when an item's top is above target.
 */
function StickyTracker({
  messages,
  start,
  end,
  offsets,
  getItemTop,
  getItemElement,
  scrollRef
}: {
  messages: RenderableMessage[];
  start: number;
  end: number;
  offsets: ArrayLike<number>;
  getItemTop: (index: number) => number;
  getItemElement: (index: number) => DOMElement | null;
  scrollRef: RefObject<ScrollBoxHandle | null>;
}): null {
  const {
    setStickyPrompt
  } = useContext(ScrollChromeContext);
  // Fine-grained subscription — snapshot is unquantized scrollTop+delta so
  // every scroll action (wheel tick, PgUp, drag) triggers a re-render of
  // THIS component only. Sticky bit folded into the sign so sticky→broken
  // also triggers (scrollToBottom sets sticky without moving scrollTop).
  const subscribe = useCallback((listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB, [scrollRef]);
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current;
    if (!s) return NaN;
    const t = s.getScrollTop() + s.getPendingDelta();
    return s.isSticky() ? -1 - t : t;
  });

  // Read live scroll state on every render.
  const isSticky = scrollRef.current?.isSticky() ?? true;
  const target = Math.max(0, (scrollRef.current?.getScrollTop() ?? 0) + (scrollRef.current?.getPendingDelta() ?? 0));

  // Walk the mounted range to find the first item at-or-below the viewport
  // top. `range` is from the parent's coarse-quantum render (may be slightly
  // stale) but overscan guarantees it spans well past the viewport in both
  // directions. Items without a Yoga layout yet (newly mounted this frame)
  // are treated as at-or-below — they're somewhere in view, and assuming
  // otherwise would show a sticky for a prompt that's actually on screen.
  let firstVisible = start;
  let firstVisibleTop = -1;
  for (let i = end - 1; i >= start; i--) {
    const top = getItemTop(i);
    if (top >= 0) {
      if (top < target) break;
      firstVisibleTop = top;
    }
    firstVisible = i;
  }
  let idx = -1;
  let text: string | null = null;
  if (firstVisible > 0 && !isSticky) {
    for (let i = firstVisible - 1; i >= 0; i--) {
      const t = stickyPromptText(messages[i]!);
      if (t === null) continue;
      // The prompt's wrapping Box top is above target (that's why it's in
      // the [0, firstVisible) range), but its ❯ is at top+1 (marginTop=1).
      // If the ❯ is at-or-below target, it's VISIBLE at viewport top —
      // showing the same text in the header would duplicate it. Happens
      // in the 1-row gap between Box top scrolling past and ❯ scrolling
      // past. Skip to the next-older prompt (its ❯ is definitely above).
      const top = getItemTop(i);
      if (top >= 0 && top + 1 >= target) continue;
      idx = i;
      text = t;
      break;
    }
  }
  const baseOffset = firstVisibleTop >= 0 ? firstVisibleTop - offsets[firstVisible]! : 0;
  const estimate = idx >= 0 ? Math.max(0, baseOffset + offsets[idx]!) : -1;

  // For click-jumps to items not yet mounted (user scrolled far past,
  // prompt is in the topSpacer). Click handler scrolls to the estimate
  // to mount it; this anchors by element once it appears. scrollToElement
  // defers the Yoga-position read to render time (render-node-to-output
  // reads el.yogaNode.getComputedTop() in the SAME calculateLayout pass
  // that produces scrollHeight) — no throttle race. Cap retries: a /clear
  // race could unmount the item mid-sequence.
  const pending = useRef({
    idx: -1,
    tries: 0
  });
  // Suppression state machine. The click handler arms; the onChange effect
  // consumes (armed→force) then fires-and-clears on the render AFTER that
  // (force→none). The force step poisons the dedup: after click, idx often
  // recomputes to the SAME prompt (its top is still above target), so
  // without force the last.idx===idx guard would hold 'clicked' until the
  // user crossed a prompt boundary. Previously encoded in last.idx as
  // -1/-2/-3 which overlapped with real indices — too clever.
  type Suppress = 'none' | 'armed' | 'force';
  const suppress = useRef<Suppress>('none');
  // Dedup on idx only — estimate derives from firstVisibleTop which shifts
  // every scroll tick, so including it in the key made the guard dead
  // (setStickyPrompt fired a fresh {text,scrollTo} per-frame). The scrollTo
  // closure still captures the current estimate; it just doesn't need to
  // re-fire when only estimate moved.
  const lastIdx = useRef(-1);

  // setStickyPrompt effect FIRST — must see pending.idx before the
  // correction effect below clears it. On the estimate-fallback path, the
  // render that mounts the item is ALSO the render where correction clears
  // pending; if this ran second, the pending gate would be dead and
  // setStickyPrompt(prevPrompt) would fire mid-jump, re-mounting the
  // header over 'clicked'.
  useEffect(() => {
    // Hold while two-phase correction is in flight.
    if (pending.current.idx >= 0) return;
    if (suppress.current === 'armed') {
      suppress.current = 'force';
      return;
    }
    const force = suppress.current === 'force';
    suppress.current = 'none';
    if (!force && lastIdx.current === idx) return;
    lastIdx.current = idx;
    if (text === null) {
      setStickyPrompt(null);
      return;
    }
    // First paragraph only (split on blank line) — a prompt like
    // "still seeing bugs:\n\n1. foo\n2. bar" previews as just the
    // lead-in. trimStart so a leading blank line (queued_command mid-
    // turn messages sometimes have one) doesn't find paraEnd at 0.
    const trimmed = text.trimStart();
    const paraEnd = trimmed.search(/\n\s*\n/);
    const collapsed = (paraEnd >= 0 ? trimmed.slice(0, paraEnd) : trimmed).slice(0, STICKY_TEXT_CAP).replace(/\s+/g, ' ').trim();
    if (collapsed === '') {
      setStickyPrompt(null);
      return;
    }
    const capturedIdx = idx;
    const capturedEstimate = estimate;
    setStickyPrompt({
      text: collapsed,
      scrollTo: () => {
        // Hide header, keep padding collapsed — FullscreenLayout's
        // 'clicked' sentinel → scrollBox_y=0 + pad=0 → viewportTop=0.
        setStickyPrompt('clicked');
        suppress.current = 'armed';
        // scrollToElement anchors by DOMElement ref, not a number:
        // render-node-to-output reads el.yogaNode.getComputedTop() at
        // paint time (same Yoga pass as scrollHeight). No staleness from
        // the throttled render — the ref is stable, the position read is
        // deferred. offset=1 = UserPromptMessage marginTop.
        const el = getItemElement(capturedIdx);
        if (el) {
          scrollRef.current?.scrollToElement(el, 1);
        } else {
          // Not mounted (scrolled far past — in topSpacer). Jump to
          // estimate to mount it; correction effect re-anchors once it
          // appears. Estimate is DEFAULT_ESTIMATE-based — lands short.
          scrollRef.current?.scrollTo(capturedEstimate);
          pending.current = {
            idx: capturedIdx,
            tries: 0
          };
        }
      }
    });
    // No deps — must run every render. Suppression state lives in a ref
    // (not idx/estimate), so a deps-gated effect would never see it tick.
    // Body's own guards short-circuit when nothing changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Correction: for click-jumps to unmounted items. Click handler scrolled
  // to the estimate; this re-anchors by element once the item appears.
  // scrollToElement defers the Yoga read to paint time — deterministic.
  // SECOND so it clears pending AFTER the onChange gate above has seen it.
  useEffect(() => {
    if (pending.current.idx < 0) return;
    const el = getItemElement(pending.current.idx);
    if (el) {
      scrollRef.current?.scrollToElement(el, 1);
      pending.current = {
        idx: -1,
        tries: 0
      };
    } else if (++pending.current.tries > 5) {
      pending.current = {
        idx: -1,
        tries: 0
      };
    }
  });
  return null;
}
