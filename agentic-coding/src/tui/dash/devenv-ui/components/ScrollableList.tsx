/** @jsxImportSource @opentui/solid */
import { Show, For, createMemo, type JSX } from 'solid-js';
import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { uiColors } from '../colors';
import { calculateVisibleItems } from '../utils/virtualScroll';
import { focusSoon } from '../utils/focusSoon';
import { AnimatedStatusText } from './AnimatedStatusText';

// ─── Layout constants ────────────────────────────────────────────────────────

/**
 * Lines consumed by the top-level <Layout> wrapper (header: 3 + footer: 3).
 * Import this constant when computing `reservedLines` for any full-screen view
 * that is rendered inside <Layout>.
 *
 * @see packages/ui/src/components/Layout.tsx
 */
export const LAYOUT_CHROME_LINES = 5;

// ─── Internal constants ───────────────────────────────────────────────────────

/** Lines consumed by the built-in filter bar (input row + marginBottom). */
const FILTER_BAR_LINES = 2;

/** Lines consumed by the scroll indicator (indicator row + marginTop). */
const SCROLL_INDICATOR_LINES = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScrollableListProps<T> {
  // ── Data ───────────────────────────────────────────────────────────────────
  /** Pre-filtered list of items to render. */
  items: T[];

  /** Currently selected item index within `items`. */
  selectedIndex: number;

  /**
   * Row renderer.  `isSelected` is a **getter** (not a plain boolean) so
   * SolidJS fine-grained reactivity is preserved when only `selectedIndex`
   * changes without `items` changing.
   *
   * Usage inside renderItem:
   * ```tsx
   * <MyRow selected={isSelected()} item={item} />
   * ```
   */
  renderItem: (item: T, isSelected: () => boolean, absoluteIndex: number) => JSX.Element;

  // ── Height budget ───────────────────────────────────────────────────────────
  /**
   * Lines of **all** fixed chrome that lie outside this component and eat into
   * the available terminal height.  Include every fixed-height element that is
   * on screen at the same time as this list:
   *
   * | Source                          | Lines |
   * |---------------------------------|-------|
   * | Layout header                   |   3   |
   * | Layout footer                   |   3   |
   * | Component outer rounded border  |   2   |
   * | Component title / stats rows    |   N   |
   * | Tab bar (if present)            |   3   |
   * | Table / column header row       |   1   |
   *
   * Use the exported `LAYOUT_CHROME_LINES` (= 5) constant for the Layout pair.
   *
   * The component automatically reserves additional lines for its **own**
   * internal chrome (filter bar, scroll indicator) — do NOT include those here.
   *
   * Mutually exclusive with `availableLines`.  When both are provided,
   * `availableLines` takes precedence.
   *
   * @example
   * // Full-screen view inside Layout with rounded border, 2-row title, and 1-row table header:
   * reservedLines={LAYOUT_CHROME_LINES + 2 + 2 + 1}  // = 10
   */
  reservedLines?: number;

  /**
   * Directly specifies the number of lines available for the scrollable list
   * area **before** subtracting the filter bar and scroll indicator (which are
   * handled automatically).
   *
   * Use this inside modal dialogs where the available height is
   * `dialogHeight − modalChrome` rather than `terminalHeight − reservedLines`.
   *
   * Mutually exclusive with `reservedLines`.
   */
  availableLines?: number;

  // ── Item sizing ─────────────────────────────────────────────────────────────
  /**
   * Uniform row height in terminal lines (default: `1`).
   * Ignored when `itemHeights` is provided.
   */
  estimatedItemHeight?: number;

  /**
   * Per-item heights array whose length **must** equal `items.length`.
   * Enables accurate virtual scrolling for variable-height rows such as
   * discussion threads.  When provided, `estimatedItemHeight` is ignored.
   */
  itemHeights?: number[];

  // ── Scroll indicator ────────────────────────────────────────────────────────
  /**
   * Show a "Showing X–Y of N [label]" line below the list.
   * Defaults to `true` whenever `items.length > 0`.
   */
  showScrollIndicator?: boolean;

  /**
   * Noun appended to the scroll indicator.
   * E.g. `"branches"` → `"Showing 1–10 of 20 branches"`.
   */
  scrollIndicatorLabel?: string;

  // ── Scrollbar ────────────────────────────────────────────────────────────────
  /**
   * Show a vertical scrollbar on the right edge of the list.
   * Only rendered when the item count exceeds the visible window.
   * Default: `true`.
   */
  showScrollbar?: boolean;

  // ── Empty state ─────────────────────────────────────────────────────────────
  /**
   * Content rendered centred in the available space when `items` is empty and
   * `loading` is false.  Defaults to a plain `"No items"` message.
   */
  emptyContent?: JSX.Element;

  // ── Loading state ───────────────────────────────────────────────────────────
  /** When true, shows the loading indicator instead of the list. */
  loading?: boolean;

  /** Text shown while loading.  Default: `"Loading…"` */
  loadingText?: string;

  // ── Built-in filter bar ─────────────────────────────────────────────────────
  /**
   * Placeholder text for the filter input.
   * When provided, a standard filter bar is rendered above the list.
   * Keyboard activation (e.g. pressing `/`) is handled by the caller.
   */
  filterPlaceholder?: string;

  /**
   * When `true`, the filter `<input>` is rendered and auto-focused.
   * When `false` (or absent), a dormant hint line is shown instead.
   */
  filterActive?: boolean;

  /**
   * Current filter query string (lives in the caller's store).
   * Displayed in the dormant filter bar; pre-populates the active `<input>`.
   */
  filterQuery?: string;

  /** Called each time the user types in the active filter input. */
  onFilterChange?: (query: string) => void;

  /** Called when mouse wheel/trackpad scrolls over the list rows. */
  onScroll?: (direction: 'up' | 'down' | 'left' | 'right', delta: number) => void;
}

/**
 * ScrollableList — universal virtual-scroll list primitive.
 *
 * ## What it does
 * - Keeps the selected item always in view (virtual windowing via `calculateVisibleItems`)
 * - Supports uniform-height rows (`estimatedItemHeight`) and variable-height rows (`itemHeights`)
 * - Never overflows its container (`overflow: hidden` on the rows box)
 * - Shows a "Showing X–Y of N" scroll indicator
 * - Loading and empty states
 * - Built-in activatable filter bar (same pattern as `ListViewModal`)
 *
 * ## Height calculation
 * The component needs to know how many lines it has available.  Supply either:
 * - `reservedLines` — total fixed chrome **outside** this component (Layout header/footer,
 *   component borders, title rows, tab bars…).  The component computes
 *   `availableLines = terminalHeight − reservedLines` and then subtracts its own
 *   internal chrome (filter bar, scroll indicator).
 * - `availableLines` — directly specify the content area height (for modal dialogs
 *   where the available height is `dialogHeight − modalChrome`).
 *
 * ## Usage
 *
 * ### Full-screen view inside Layout with a border and a 2-row title section:
 * ```tsx
 * <ScrollableList
 *   items={files}
 *   selectedIndex={selectedIndex()}
 *   renderItem={(file, isSelected) => <FileRow file={file} selected={isSelected()} />}
 *   reservedLines={LAYOUT_CHROME_LINES + 2 + 2 + 1}  // layout(5) + border(2) + title(2) + tableHeader(1)
 *   scrollIndicatorLabel="files"
 * />
 * ```
 *
 * ### Inside a GenericModal dialog:
 * ```tsx
 * <ScrollableList
 *   items={branches}
 *   selectedIndex={branchIndex()}
 *   renderItem={...}
 *   availableLines={dialogContentHeight}
 *   scrollIndicatorLabel="branches"
 * />
 * ```
 *
 * ### Variable-height rows (e.g. discussion threads):
 * ```tsx
 * const heights = createMemo(() => items.map(d => d.isSystem ? 2 : 4));
 * <ScrollableList
 *   items={discussions()}
 *   selectedIndex={selectedIndex()}
 *   renderItem={renderDiscussion}
 *   itemHeights={heights()}
 *   reservedLines={LAYOUT_CHROME_LINES + 2 + 2}
 * />
 * ```
 */
export function ScrollableList<T>(props: ScrollableListProps<T>): JSX.Element {
  const dimensions = useTerminalDimensions();

  const hasFilterBar = () => !!props.filterPlaceholder;
  const showIndicator = () =>
    props.showScrollIndicator !== false && props.items.length > 0;

  /**
   * Lines available for actual list rows, after subtracting outer chrome
   * (via reservedLines / availableLines) and internal chrome (filter bar +
   * scroll indicator).
   */
  const listAreaLines = createMemo(() => {
    const base =
      props.availableLines !== undefined
        ? props.availableLines
        : Math.max(1, dimensions().height - (props.reservedLines ?? 0));

    const filterLines = hasFilterBar() ? FILTER_BAR_LINES : 0;
    const indicatorLines = showIndicator() ? SCROLL_INDICATOR_LINES : 0;
    return Math.max(1, base - filterLines - indicatorLines);
  });

  const maxVisibleUniformItems = createMemo(() =>
    Math.max(1, Math.floor(listAreaLines() / (props.estimatedItemHeight ?? 1))),
  );

  const uniformWindowStart = createMemo(() => {
    if (props.items.length === 0 || props.itemHeights) return 0;
    const maxVisible = maxVisibleUniformItems();
    const clampedSelected = Math.max(0, Math.min(props.selectedIndex, props.items.length - 1));
    const pageStart = Math.floor(clampedSelected / maxVisible) * maxVisible;
    return Math.max(0, Math.min(pageStart, Math.max(0, props.items.length - maxVisible)));
  });

  /** Virtual window: only the items that fit on screen around the selection. */
  const visibleItems = createMemo(() => {
    if (props.items.length === 0) return [];

    // Hot path for uniform-height lists (tables, issues, CRs): depend on the
    // page window, not the exact selected index, so holding j/k only updates
    // selection styling and does not recreate every visible row.
    if (!props.itemHeights) {
      const startIdx = uniformWindowStart();
      const endIdx = Math.min(props.items.length, startIdx + maxVisibleUniformItems());
      return props.items.slice(startIdx, endIdx).map((item, idx) => ({
        item,
        absoluteIndex: startIdx + idx,
      }));
    }

    const result = calculateVisibleItems(props.items, {
      totalItems: props.items.length,
      selectedIndex: props.selectedIndex,
      visibleHeight: listAreaLines(),
      estimatedItemHeight: props.estimatedItemHeight ?? 1,
      itemHeights: props.itemHeights,
    });
    return result.visibleItems;
  });

  /** True only when items overflow the visible window — drives scrollbar visibility. */
  const needsScrollbar = () =>
    props.showScrollbar !== false &&
    props.items.length > 0 &&
    visibleItems().length < props.items.length;

  const handleMouseScroll = (event: any) => {
    const direction = event.scroll?.direction;
    if (!direction) return;
    props.onScroll?.(direction, Math.max(1, Math.round(Math.abs(event.scroll?.delta ?? 1))));
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  /**
   * Top offset of the scrollbar thumb in terminal lines.
   * Proportional to how far into the list the visible window starts.
   */
  const thumbTop = createMemo(() => {
    const total = props.items.length;
    const startIdx = visibleItems()[0]?.absoluteIndex ?? 0;
    return Math.floor(listAreaLines() * startIdx / total);
  });

  /**
   * Height of the scrollbar thumb in terminal lines (minimum 1).
   * Proportional to the fraction of items currently visible.
   */
  const thumbHeight = createMemo(() => {
    const total = props.items.length;
    const visible = visibleItems().length;
    return Math.max(1, Math.ceil(listAreaLines() * visible / total));
  });

  return (
    <>
      {/* ── Filter bar ──────────────────────────────────────────────────────── */}
      <Show when={hasFilterBar()}>
        <Show
          when={props.filterActive}
          fallback={
            /* Dormant: show "/" hint and the active query (or placeholder) */
            <box
              style={{
                width: '100%',
                height: 1,
                flexDirection: 'row',
                flexShrink: 0,
                marginBottom: 1,
              }}
            >
              <text fg={uiColors.textMuted}>{'/ '}</text>
              <Show
                when={props.filterQuery}
                fallback={<text fg={uiColors.textMuted}>{props.filterPlaceholder}</text>}
              >
                <text fg={uiColors.textPrimary}>{props.filterQuery}</text>
              </Show>
            </box>
          }
        >
          {/* Active: auto-focused <input> element */}
          <box
            style={{
              width: '100%',
              height: 1,
              flexDirection: 'row',
              flexShrink: 0,
              marginBottom: 1,
            }}
          >
            <text fg={uiColors.textMuted}>{'/ '}</text>
            <input
              ref={(el: any) => {
                focusSoon(el);
              }}
              onInput={(val: string) => props.onFilterChange?.(val)}
              placeholder={props.filterPlaceholder}
              style={{ flexGrow: 1 }}
              focusedBackgroundColor={uiColors.bgBase}
              focusedTextColor={uiColors.textPrimary}
            />
          </box>
        </Show>
      </Show>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <Show
        when={!props.loading}
        fallback={
          <box
            style={{
              width: '100%',
              flexGrow: 1,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <AnimatedStatusText text={props.loadingText ?? 'Loading…'} intent="load" backgroundColor={uiColors.bgMantle} />
          </box>
        }
      >
        <Show
          when={props.items.length > 0}
          fallback={
            <box
              style={{
                width: '100%',
                flexGrow: 1,
                justifyContent: 'center',
                alignItems: 'center',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              {props.emptyContent ?? (
                <text fg={uiColors.textMuted}>No items</text>
              )}
            </box>
          }
        >
          {/*
           * Outer row: list content + optional scrollbar side by side.
           * The scrollbar is 1 char wide and only rendered when items overflow.
           */}
          <box
            onMouseScroll={handleMouseScroll}
            style={{
              width: '100%',
              height: listAreaLines(),
              flexGrow: 0,
              flexShrink: 0,
              minHeight: 0,
              flexDirection: 'row',
              overflow: 'hidden',
            }}
          >
            {/* List rows — overflow: hidden prevents rounding leaks */}
            <box
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minHeight: 0,
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <For each={visibleItems()}>
                {(visibleItem) => {
                  const isSelected = () =>
                    visibleItem.absoluteIndex === props.selectedIndex;
                  return props.renderItem(
                    visibleItem.item,
                    isSelected,
                    visibleItem.absoluteIndex,
                  );
                }}
              </For>
            </box>

            {/* Scrollbar (1 char wide, thumb + track) */}
            <Show when={needsScrollbar()}>
              <box
                style={{
                  width: 1,
                  flexShrink: 0,
                  flexDirection: 'column',
                  minHeight: 0,
                  overflow: 'hidden',
                }}
              >
                {/* Track above thumb */}
                <Show when={thumbTop() > 0}>
                  <box
                    style={{ width: 1, height: thumbTop(), flexShrink: 0 }}
                    backgroundColor={uiColors.scrollbarTrack}
                  />
                </Show>
                {/* Thumb */}
                <box
                  style={{ width: 1, height: thumbHeight(), flexShrink: 0 }}
                  backgroundColor={uiColors.scrollbarThumb}
                />
                {/* Track below thumb - flexGrow with minHeight:0 so it collapses to 0 at end-of-scroll */}
                <box
                  style={{ width: 1, flexGrow: 1, minHeight: 0 }}
                  backgroundColor={uiColors.scrollbarTrack}
                />
              </box>
            </Show>
          </box>

          {/* ── Scroll indicator ──────────────────────────────────────────── */}
          <Show when={showIndicator()}>
            <box
              style={{
                width: '100%',
                height: 1,
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <text fg={uiColors.textMuted}>
                Showing{' '}
                {(visibleItems()[0]?.absoluteIndex ?? 0) + 1}–
                {(visibleItems()[visibleItems().length - 1]?.absoluteIndex ?? 0) + 1}{' '}
                of {props.items.length}
                {props.scrollIndicatorLabel ? ` ${props.scrollIndicatorLabel}` : ''}
              </text>
            </box>
          </Show>
        </Show>
      </Show>
    </>
  );
}
