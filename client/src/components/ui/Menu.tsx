import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * A menu that opens from a trigger (R01.2).
 *
 * Why a portal: rows live in tables, in drag-and-drop lists and inside the
 * player's scrolling queue panel, and every earlier dropdown in this app was
 * an `absolute` child of its trigger — which a scroll container clips. The
 * panel is rendered on `document.body` and placed from the trigger's
 * position instead.
 *
 * Two React details matter because of that portal:
 *  - Synthetic events still bubble through the React tree, so a click on an
 *    item would reach the row's own onClick and start playing it. The panel
 *    stops click and key propagation.
 *  - The global shortcuts listen on `window` (Space = play/pause). Stopping
 *    the key event here keeps Space and Enter on a menu item from also
 *    toggling playback.
 *
 * On a narrow screen the same content is a sheet from the bottom edge, with
 * thumb-sized rows, instead of a small floating box.
 */

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** The element that opened the menu: positions the panel and gets focus back. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name of the menu. */
  label: string;
  children: ReactNode;
}

const SHEET_BREAKPOINT = 640;
const PANEL_WIDTH = 240;
const GAP = 4;

interface Placement {
  top: number;
  left: number;
  sheet: boolean;
}

function place(anchor: HTMLElement | null, panelHeight: number): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw < SHEET_BREAKPOINT || !anchor) return { top: 0, left: 0, sheet: true };
  const rect = anchor.getBoundingClientRect();
  // Right-aligned under the trigger, flipped above when it would run off the
  // bottom, and kept inside the viewport horizontally.
  let top = rect.bottom + GAP;
  if (top + panelHeight > vh - 8 && rect.top - GAP - panelHeight > 8) {
    top = rect.top - GAP - panelHeight;
  }
  const left = Math.min(Math.max(8, rect.right - PANEL_WIDTH), vw - PANEL_WIDTH - 8);
  return { top, left, sheet: false };
}

function items(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
  );
}

export function Menu({ open, onClose, anchorRef, label, children }: MenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement>({ top: 0, left: 0, sheet: false });

  const close = useCallback(
    (returnFocus: boolean) => {
      onClose();
      if (returnFocus) anchorRef.current?.focus();
    },
    [onClose, anchorRef],
  );

  // Measure after the panel exists, so the flip-above decision uses its real
  // height, then put focus on the first item for keyboard users.
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () =>
      setPlacement(place(anchorRef.current, panelRef.current?.offsetHeight ?? 0));
    reposition();
    items(panelRef.current)[0]?.focus();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, anchorRef]);

  // Outside press closes. Pointer rather than click, so the press that opens
  // another row's menu also closes this one in the same gesture.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close, anchorRef]);

  if (!open) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const list = items(panelRef.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'Tab':
        // Leaving the menu closes it; focus goes back where it came from.
        event.preventDefault();
        close(true);
        return;
      case 'ArrowDown':
        event.preventDefault();
        list[(at + 1) % list.length]?.focus();
        return;
      case 'ArrowUp':
        event.preventDefault();
        list[(at - 1 + list.length) % list.length]?.focus();
        return;
      case 'Home':
        event.preventDefault();
        list[0]?.focus();
        return;
      case 'End':
        event.preventDefault();
        list[list.length - 1]?.focus();
        return;
      default:
    }
  };

  const panel = (
    // The panel only contains buttons; the key and click handlers are there to
    // keep events from reaching the row and the global shortcuts (see above).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={placement.sheet ? 'fixed inset-0 z-[120] flex items-end' : undefined}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {placement.sheet && (
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className="absolute inset-0 bg-black/50"
          onClick={() => close(true)}
        />
      )}
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        className={
          placement.sheet
            ? 'relative w-full max-h-[80vh] overflow-y-auto rounded-t-2xl bg-surface border-t border-white/10 py-2 safe-bottom shadow-2xl'
            : 'fixed z-[120] rounded-lg bg-surface border border-white/10 py-1 shadow-xl'
        }
        style={
          placement.sheet
            ? undefined
            : { top: placement.top, left: placement.left, width: PANEL_WIDTH }
        }
      >
        {placement.sheet && (
          <p className="px-4 pt-1 pb-2 text-xs uppercase tracking-wide text-gray-500 truncate">
            {label}
          </p>
        )}
        {children}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

export interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** Keep the menu open after this item (e.g. it switches to a sub-list). */
  keepOpen?: boolean;
  onClose?: () => void;
  /** Right-hand hint, such as a check mark or "loading". */
  hint?: ReactNode;
}

export function MenuItem({ onSelect, children, disabled, keepOpen, onClose, hint }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={() => {
        if (disabled) return;
        onSelect();
        if (!keepOpen) onClose?.();
      }}
      className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 sm:py-2 text-left text-sm transition focus:outline-none focus-visible:bg-white/10 hover:bg-white/10 ${
        disabled ? 'cursor-not-allowed opacity-40' : ''
      }`}
    >
      <span className="truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-gray-500">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-white/10" />;
}
