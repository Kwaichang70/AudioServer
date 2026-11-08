import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { onApiError, type ApiError } from '../api/client.js';

interface ToastMessage {
  id: number;
  text: string;
  type: 'info' | 'error' | 'success';
}

interface ToastContextValue {
  toast: (text: string, type?: 'info' | 'error' | 'success') => void;
}

const ToastCtx = createContext<ToastContextValue>({ toast: () => {} });

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const toast = useCallback((text: string, type: 'info' | 'error' | 'success' = 'info') => {
    const id = nextId++;
    setMessages((prev) => [...prev, { id, text, type }]);
    // An error stays long enough to be read (U03); a confirmation does not.
    setTimeout(
      () => {
        setMessages((prev) => prev.filter((m) => m.id !== id));
      },
      type === 'error' ? 7000 : 3000,
    );
  }, []);

  // Auto-toast API errors so callers don't need to wire up try/catch + toast on
  // every fetch. 401s are deliberately silent — App.tsx redirects to login on
  // those, and a toast on every protected request during reauth is noise.
  useEffect(() => {
    return onApiError((err: ApiError) => {
      if (err.isUnauthorized) return;
      toast(err.message, 'error');
    });
  }, [toast]);

  const colors = {
    info: 'bg-surface-light border-white/20',
    error: 'bg-red-900/80 border-red-500/50',
    success: 'bg-green-900/80 border-green-500/50',
  };

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {/* Above every overlay, the full player included (U03), announced to
          screen readers, and kept usable while a dialog makes the page inert. */}
      <div
        className="fixed bottom-24 right-4 z-[120] flex flex-col gap-2 max-w-[calc(100vw-2rem)]"
        aria-live="polite"
        data-stays-active=""
      >
        {messages.map((m) => (
          <div
            key={m.id}
            role={m.type === 'error' ? 'alert' : 'status'}
            className={`px-4 py-2 rounded-lg border text-sm shadow-lg animate-fade-in ${colors[m.type]}`}
          >
            {m.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
