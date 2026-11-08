import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A full-screen dialog that behaves like one (U02): focus moves into it when
 * it opens, Tab and Shift+Tab stay inside, what lies behind it is inert (no
 * clicks, no focus, hidden from screen readers), and focus returns to the
 * button that opened it when it closes.
 */
export function useDialogFocus(
  dialog: RefObject<HTMLElement | null>,
  initial?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Everything next to the dialog (and next to each of its ancestors) goes inert.
    const madeInert: Element[] = [];
    for (
      let node: Element | null = root;
      node && node !== document.body;
      node = node.parentElement
    ) {
      for (const sibling of Array.from(node.parentElement?.children ?? [])) {
        if (sibling === node || sibling.hasAttribute('inert')) continue;
        if (sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE') continue;
        // Notifications stay readable over the dialog (see Toast).
        if (sibling.hasAttribute('data-stays-active')) continue;
        sibling.setAttribute('inert', '');
        madeInert.push(sibling);
      }
    }

    (initial?.current ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Only what can be seen: a control in a closed menu is not a stop.
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.checkVisibility?.() ?? true,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      for (const el of madeInert) el.removeAttribute('inert');
      if (opener && document.contains(opener)) opener.focus();
    };
    // Once per opening: the refs are stable for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
