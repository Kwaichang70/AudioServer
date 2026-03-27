import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

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
    setTimeout(() => {
      setMessages((prev) => prev.filter((m) => m.id !== id));
    }, 3000);
  }, []);

  const colors = {
    info: 'bg-surface-light border-white/20',
    error: 'bg-red-900/80 border-red-500/50',
    success: 'bg-green-900/80 border-green-500/50',
  };

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-24 right-4 z-50 flex flex-col gap-2">
        {messages.map((m) => (
          <div
            key={m.id}
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
