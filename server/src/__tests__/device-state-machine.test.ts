import { describe, expect, it } from 'vitest';
import { DeviceStateMachine, InvalidDeviceStateTransitionError } from '../devices/state-machine.js';

describe('DeviceStateMachine', () => {
  it('tracks a normal external playback lifecycle', () => {
    const machine = new DeviceStateMachine();

    expect(machine.get('device-1').state).toBe('idle');
    expect(machine.transition('device-1', 'loading', { track: makeTrack() }).state).toBe('loading');
    expect(machine.transition('device-1', 'playing').state).toBe('playing');
    expect(machine.transition('device-1', 'paused').state).toBe('paused');
    expect(machine.transition('device-1', 'playing').state).toBe('playing');
    expect(machine.transition('device-1', 'stopped').state).toBe('stopped');
  });

  it('captures device errors for UI/status surfaces', () => {
    const machine = new DeviceStateMachine();

    machine.transition('device-1', 'loading', { track: makeTrack() });
    const state = machine.transition('device-1', 'error', {
      error: new Error('Renderer rejected URI'),
    });

    expect(state.state).toBe('error');
    expect(state.previousState).toBe('loading');
    expect(state.lastError).toBe('Renderer rejected URI');
  });

  it('rejects transitions that would hide impossible state flow', () => {
    const machine = new DeviceStateMachine();

    expect(() => machine.transition('device-1', 'idle')).not.toThrow();
    expect(() => machine.transition('device-1', 'idle')).not.toThrow();
    expect(() => machine.transition('device-1', 'error')).not.toThrow();
    expect(() => machine.transition('device-1', 'idle')).not.toThrow();
    expect(() => machine.transition('device-1', 'paused')).not.toThrow();
    expect(() => machine.transition('device-1', 'idle')).toThrow(InvalidDeviceStateTransitionError);
  });

  it('reconciles polled playback state into session state', () => {
    const machine = new DeviceStateMachine();

    expect(machine.reconcilePlaybackState('device-1', 'buffering').state).toBe('loading');
    expect(machine.reconcilePlaybackState('device-1', 'playing').state).toBe('playing');
    expect(machine.reconcilePlaybackState('device-1', 'paused').state).toBe('paused');
    expect(machine.reconcilePlaybackState('device-1', 'stopped').state).toBe('stopped');
  });
});

function makeTrack() {
  return { title: 'Track', artist: 'Artist', album: 'Album' };
}
