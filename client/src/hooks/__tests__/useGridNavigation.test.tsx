import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useGridNavigation } from '../useGridNavigation';

// A minimal grid harness. jsdom reports offsetTop=0 for everything, so the
// column detection collapses to "one row" — meaning Left/Right/Home/End are
// the deterministic axes to assert here. (Up/Down depend on real layout
// geometry, which jsdom doesn't provide.)
function Grid({ count }: { count: number }) {
  const { containerRef, onKeyDown } = useGridNavigation<HTMLDivElement>(count);
  return (
    <div ref={containerRef} onKeyDown={onKeyDown} data-testid="grid">
      {Array.from({ length: count }, (_, i) => (
        // eslint-disable-next-line jsx-a11y/anchor-is-valid
        <a key={i} href="#" data-grid-item data-testid={`item-${i}`}>
          item {i}
        </a>
      ))}
    </div>
  );
}

describe('useGridNavigation', () => {
  it('makes only the first item tabbable (roving tabindex)', () => {
    render(<Grid count={4} />);
    expect(screen.getByTestId('item-0').tabIndex).toBe(0);
    expect(screen.getByTestId('item-1').tabIndex).toBe(-1);
    expect(screen.getByTestId('item-3').tabIndex).toBe(-1);
  });

  it('ArrowRight moves focus + roving tabindex to the next item', () => {
    render(<Grid count={4} />);
    const first = screen.getByTestId('item-0');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    const second = screen.getByTestId('item-1');
    expect(document.activeElement).toBe(second);
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
  });

  it('ArrowLeft clamps at the first item', () => {
    render(<Grid count={4} />);
    const first = screen.getByTestId('item-0');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('End jumps to the last item, Home back to the first', () => {
    render(<Grid count={5} />);
    const first = screen.getByTestId('item-0');
    first.focus();

    fireEvent.keyDown(first, { key: 'End' });
    const last = screen.getByTestId('item-4');
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('ignores keys when focus is outside the grid items', () => {
    render(<Grid count={3} />);
    // body has focus, not a grid item → no throw, no focus change
    fireEvent.keyDown(screen.getByTestId('grid'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(document.body);
  });
});

// Vertical (1D list) orientation: Down/Up move ±1; Left/Right are ignored.
function VerticalList({ count }: { count: number }) {
  const { containerRef, onKeyDown } = useGridNavigation<HTMLDivElement>(count, {
    orientation: 'vertical',
  });
  return (
    <div ref={containerRef} onKeyDown={onKeyDown} data-testid="list">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" data-grid-item data-testid={`row-${i}`}>
          row {i}
        </button>
      ))}
    </div>
  );
}

describe('useGridNavigation (vertical)', () => {
  it('ArrowDown moves to the next row, ArrowUp back', () => {
    render(<VerticalList count={3} />);
    const first = screen.getByTestId('row-0');
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('row-1'));

    fireEvent.keyDown(screen.getByTestId('row-1'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('ignores ArrowRight / ArrowLeft in vertical mode', () => {
    render(<VerticalList count={3} />);
    const first = screen.getByTestId('row-0');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });
});
