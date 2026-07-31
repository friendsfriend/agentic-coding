/**
 * Virtual scrolling utilities for list views
 * Keeps selected items in view by rendering only visible items
 */

export interface VirtualScrollOptions {
  totalItems: number;
  selectedIndex: number;
  visibleHeight: number;
  /** Uniform height for all items. Used when itemHeights is not provided. */
  estimatedItemHeight?: number;
  /**
   * Per-item heights array (length === totalItems).
   * When provided, exact heights are used instead of estimatedItemHeight,
   * which is essential for lists with variable-height rows.
   */
  itemHeights?: number[];
}

export interface VisibleItem<T> {
  item: T;
  absoluteIndex: number;
}

export interface VirtualScrollResult<T> {
  visibleItems: VisibleItem<T>[];
  startIndex: number;
  endIndex: number;
}

/**
 * Calculate which items should be rendered to keep the selected item visible.
 *
 * When itemHeights is provided, the window is grown from the selected item
 * outward until the available height is filled, giving pixel-accurate scrolling
 * for variable-height lists.
 *
 * Falls back to the uniform estimatedItemHeight path when itemHeights is absent.
 */
export function calculateVisibleItems<T>(
  allItems: T[],
  options: VirtualScrollOptions,
): VirtualScrollResult<T> {
  const {
    totalItems,
    selectedIndex,
    visibleHeight,
    estimatedItemHeight = 6,
    itemHeights,
  } = options;

  if (totalItems === 0) {
    return { visibleItems: [], startIndex: 0, endIndex: 0 };
  }

  const clampedSelected = Math.max(0, Math.min(selectedIndex, totalItems - 1));

  if (itemHeights && itemHeights.length === totalItems) {
    // Variable-height path: start at the selected item and expand outward
    let startIdx = clampedSelected;
    let endIdx = clampedSelected + 1; // exclusive
    let usedHeight = itemHeights[clampedSelected];

    let canExpandAbove = startIdx > 0;
    let canExpandBelow = endIdx < totalItems;

    while ((canExpandAbove || canExpandBelow) && usedHeight < visibleHeight) {
      if (canExpandAbove) {
        const h = itemHeights[startIdx - 1];
        if (usedHeight + h <= visibleHeight) {
          startIdx--;
          usedHeight += h;
          canExpandAbove = startIdx > 0;
        } else {
          canExpandAbove = false;
        }
      }
      if (canExpandBelow && usedHeight < visibleHeight) {
        const h = itemHeights[endIdx];
        if (usedHeight + h <= visibleHeight) {
          endIdx++;
          usedHeight += h;
          canExpandBelow = endIdx < totalItems;
        } else {
          canExpandBelow = false;
        }
      }
    }

    const visibleItems = allItems.slice(startIdx, endIdx).map((item, idx) => ({
      item,
      absoluteIndex: startIdx + idx,
    }));

    return { visibleItems, startIndex: startIdx, endIndex: endIdx };
  }

  // Uniform-height path.
  // Keep the rendered window stable while the selection moves inside it.
  // Re-centering around the selected row on every keypress causes every row in
  // CR/issue lists to churn during key repeat, making cursor movement laggy.
  const maxVisibleItems = Math.max(1, Math.floor(visibleHeight / estimatedItemHeight));
  const pageStart = Math.floor(clampedSelected / maxVisibleItems) * maxVisibleItems;
  const startIdx = Math.max(0, Math.min(pageStart, Math.max(0, totalItems - maxVisibleItems)));
  const endIdx = Math.min(totalItems, startIdx + maxVisibleItems);

  const visibleItems = allItems.slice(startIdx, endIdx).map((item, idx) => ({
    item,
    absoluteIndex: startIdx + idx,
  }));

  return { visibleItems, startIndex: startIdx, endIndex: endIdx };
}
