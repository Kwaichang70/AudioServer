import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Radio in the player (R08.1): on/off per room, and why a pick was chosen. */

const mocks = vi.hoisted(() => ({
  audio: {
    radio: {
      enabled: true,
      seed: { type: 'artist', id: 'ar-0', label: 'Miles Davis' },
      reasons: { 't-1': 'Related to Miles Davis (Last.fm) · genre Jazz' },
    } as unknown,
    setRadioEnabled: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));

const { default: RadioToggle, useRadioReason } = await import('../player/RadioToggle.js');

function Reason({ id }: { id: string }) {
  return <p>{useRadioReason(id) ?? 'none'}</p>;
}

describe('Radio in the player', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows radio is on, from what, and switches it off', () => {
    render(<RadioToggle />);
    const button = screen.getByRole('button', { name: 'Radio on' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('title', 'Radio on · from Miles Davis');
    fireEvent.click(button);
    expect(mocks.audio.setRadioEnabled).toHaveBeenCalledWith(false);
  });

  it('tells why radio chose the playing track, and nothing for a track you chose', () => {
    render(
      <>
        <Reason id="t-1" />
        <Reason id="t-2" />
      </>,
    );
    expect(screen.getByText('Related to Miles Davis (Last.fm) · genre Jazz')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});
