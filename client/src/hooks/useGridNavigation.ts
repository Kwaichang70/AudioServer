import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Roving-tabindex 2D keyboard navigation for a responsive grid of focusable
 * items (album/artist cards rendered as <a>/<Link>).
 *
 * Why: native <a> elements are Tab-focusable and Enter-activatable already, so
 * basic keyboard access works. What's missing for a *grid* is:
 *   - Arrow keys moving focus in two dimensions (Left/Right within a row,
 *     Up/Down between rows), and
 *   - a roving tabindex so Tab enters/leaves the whole grid as one stop
 *     instead of stepping through every card.
 *
 * Usage:
 *   const { containerRef, onKeyDown } = useGridNavigation(items.length);
 *   <div ref={containerRef} onKeyDown={onKeyDown} className="grid ...">
 *     {items.map((it) => <Link data-grid-item ... />)}
 *   </div>
 *
 * Each item must carry the `data-grid-item` attribute. The column count is
 * measured at runtime from element offsetTop, so it adapts to whatever the
 * responsive grid resolves to at the current breakpoint — no need to tell the
 * hook how many columns there are.
 */
export function useGridNavigation<T extends HTMLElement = HTMLDivElement>(itemCount: number) {
  const containerRef = useRef<T>(null);

  const getItems = useCallback((): HTMLElement[] => {
    const c = containerRef.current;
    if (!c) return [];
    return Array.from(c.querySelectorAll<HTMLElement>('[data-grid-item]'));
  }, []);

  // Number of items in the first visual row = number of columns. Items in the
  // same row share the smallest offsetTop; we count until offsetTop changes.
  const getColumns = useCallback((items: HTMLElement[]): number => {
    if (items.length <= 1) return Math.max(1, items.length);
    const firstTop = items[0].offsetTop;
    let cols = 0;
    for (const item of items) {
      if (item.offsetTop === firstTop) cols++;
      else break;
    }
    return Math.max(1, cols);
  }, []);

  // Roving tabindex: keep exactly one item tabbable so Tab treats the grid as a
  // single stop. Re-run when the item count changes (e.g. load-more appended
  // rows) so newly added cards default to tabIndex=-1.
  useEffect(() => {
    const items = getItems();
    items.forEach((item, i) => {
      item.tabIndex = i === 0 ? 0 : -1;
    });
  }, [itemCount, getItems]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<T>) => {
      const items = getItems();
      if (items.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      if (idx === -1) return; // focus isn't on a grid item — let the event be

      const cols = getColumns(items);
      let next = idx;
      switch (e.key) {
        case 'ArrowRight':
          next = Math.min(items.length - 1, idx + 1);
          break;
        case 'ArrowLeft':
          next = Math.max(0, idx - 1);
          break;
        case 'ArrowDown':
          next = Math.min(items.length - 1, idx + cols);
          break;
        case 'ArrowUp':
          next = Math.max(0, idx - cols);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = items.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (next !== idx) {
        items[idx].tabIndex = -1;
        items[next].tabIndex = 0;
        items[next].focus();
      }
    },
    [getItems, getColumns],
  );

  return { containerRef, onKeyDown };
}
