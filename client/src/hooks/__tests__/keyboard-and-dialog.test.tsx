import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { isGlobalShortcut } from '../useKeyboardShortcuts.js';
import { useDialogFocus } from '../useDialogFocus.js';

/**
 * U02: Space on a focused button presses that button instead of pausing the
 * music, and a full-screen dialog takes focus, keeps Tab inside, makes the
 * page behind it inert and gives focus back when it closes.
 */
const key = (target: Element, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
};

describe('player shortcuts', () => {
  it('leave Space and arrows to focused controls', () => {
    const button = document.createElement('button');
    const tab = Object.assign(document.createElement('div'), { role: 'tab' });
    tab.setAttribute('role', 'tab');
    expect(isGlobalShortcut(key(button, { key: ' ' }))).toBe(false);
    expect(isGlobalShortcut(key(button, { key: 'Enter' }))).toBe(false);
    expect(isGlobalShortcut(key(tab, { key: 'ArrowRight', shiftKey: true }))).toBe(false);
    expect(isGlobalShortcut(key(document.createElement('input'), { key: 'm' }))).toBe(false);
  });

  it('work on the page itself, but not with modifiers, repeats or when handled', () => {
    expect(isGlobalShortcut(key(document.body, { key: ' ' }))).toBe(true);
    expect(isGlobalShortcut(key(button(), { key: 'm' }))).toBe(true);
    expect(isGlobalShortcut(key(document.body, { key: 's', ctrlKey: true }))).toBe(false);
    expect(isGlobalShortcut(key(document.body, { key: ' ', repeat: true }))).toBe(false);
    const handled = key(document.body, { key: ' ' });
    handled.preventDefault();
    expect(isGlobalShortcut(handled)).toBe(false);
  });
});

function button() {
  return document.createElement('button');
}

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialogFocus(ref, close);
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      <button ref={close} onClick={onClose}>
        Close
      </button>
      <button>Last</button>
    </div>
  );
}

function App() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        <button onClick={() => setOpen(true)}>Open player</button>
      </main>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </>
  );
}

describe('full-screen dialog focus', () => {
  it('moves focus in, keeps Tab inside, makes the page inert, and returns focus', () => {
    render(<App />);
    const opener = screen.getByRole('button', { name: 'Open player' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(true);

    // Shift+Tab on the first control goes round to the last one.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
