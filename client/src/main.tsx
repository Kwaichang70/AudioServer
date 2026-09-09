import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ToastProvider } from './components/Toast.js';
import { AuthProvider } from './context/AuthContext.js';
import App from './App.js';
import { registerServiceWorker } from './sw/register.js';
import './index.css';

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
