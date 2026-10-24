import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ClosePrompt } from './components/ClosePrompt';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <ClosePrompt />
    </ErrorBoundary>
  </React.StrictMode>,
);
