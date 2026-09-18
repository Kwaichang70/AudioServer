import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ToastProvider } from './components/Toast.js';
import { AuthProvider } from './context/AuthContext.js';
import App from './App.js';
import { registerServiceWorker } from './sw/register.js';
import { applyTheme, readTheme } from './utils/theme.js';
import './index.css';

// Theme before the first render (R00.2): the stored choice, or what the
// operating system asks for. The Settings page used to be the only place that
// applied it, so opening the app on any other page showed dark.
applyTheme(readTheme());

// Service worker: versioned shell cache with a "reload when you want" update
// flow (V08.1). The app runs fine without it.
registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
