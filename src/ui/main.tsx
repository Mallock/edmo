import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { core } from './store.ts';
import './styles.css';

void core.init();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
