import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SeekBar, { seekDisabledReason } from '../player/SeekBar.js';

/**
 * R01.3: one seek bar for both players. Before, both copies accepted a click
 * on any output — including a speaker that cannot jump, where the bar moved
 * and the music did not.
 */
describe('SeekBar', () => {
  function barOf() {
    return screen.getByRole('slider', { name: 'Seek' });
  }

  it('jumps to where it is clicked', () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={0} duration={200} onSeek={onSeek} />);
    const bar = barOf();
    bar.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    fireEvent.click(bar, { clientX: 25 });

    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it('scrubs five seconds with the arrow keys', () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={60} duration={200} onSeek={onSeek} />);

    fireEvent.keyDown(barOf(), { key: 'ArrowRight' });
    fireEvent.keyDown(barOf(), { key: 'ArrowLeft' });

    expect(onSeek).toHaveBeenNthCalledWith(1, 65);
    expect(onSeek).toHaveBeenNthCalledWith(2, 55);
  });

  it('does nothing and says why on an output that cannot jump', () => {
    const onSeek = vi.fn();
    render(
      <SeekBar
        currentTime={60}
        duration={200}
        onSeek={onSeek}
        disabledReason="This output cannot jump inside a track"
        showTimes
      />,
    );
    const bar = barOf();
    bar.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    fireEvent.click(bar, { clientX: 50 });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });

    expect(onSeek).not.toHaveBeenCalled();
    expect(bar).toHaveAttribute('aria-disabled', 'true');
    expect(bar).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('This output cannot jump inside a track')).toBeInTheDocument();
  });

  it('describes the position in words for a screen reader', () => {
    render(<SeekBar currentTime={65} duration={200} onSeek={() => {}} />);
    expect(barOf()).toHaveAttribute('aria-valuetext', '1:05 of 3:20');
  });

  it('knows which outputs and tracks cannot seek', () => {
    expect(seekDisabledReason('supported', 't1')).toBeUndefined();
    // Unknown means "try it": the server reports a refusal and the bar learns.
    expect(seekDisabledReason('unknown', 't1')).toBeUndefined();
    expect(seekDisabledReason('unsupported', 't1')).toMatch(/cannot jump/);
    expect(seekDisabledReason('supported', 'spotify:abc')).toMatch(/Spotify/);
  });
});
