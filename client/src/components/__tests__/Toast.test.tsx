import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../Toast';

function ToastTrigger({ text, type }: { text: string; type?: 'info' | 'error' | 'success' }) {
  const { toast } = useToast();
  return <button onClick={() => toast(text, type)}>Show Toast</button>;
}

describe('Toast', () => {
  it('shows toast message when triggered', async () => {
    render(
      <ToastProvider>
        <ToastTrigger text="Hello toast" />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('Show Toast').click();
    });

    expect(screen.getByText('Hello toast')).toBeInTheDocument();
  });

  it('auto-dismisses after timeout', async () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <ToastTrigger text="Temporary" />
      </ToastProvider>
    );

    await act(async () => {
      screen.getByText('Show Toast').click();
    });

    expect(screen.getByText('Temporary')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    expect(screen.queryByText('Temporary')).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
