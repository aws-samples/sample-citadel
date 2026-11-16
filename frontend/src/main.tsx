// build: 2026-03-17T23:20
console.info('[citadel] build 20260317.2320');
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import './styles/custom.css';
import './styles/workflow.css';
import { initializeAmplify } from './config/amplify';
import { initializeSubscriptionDebug } from './services/subscriptionDebug';
import { registerPreloadErrorGuard } from './preload-error-guard'; // CIT-307

// Initialize subscription debug tools in development mode
initializeSubscriptionDebug();

// CIT-307: one-shot reload on stale chunk 404 after deploy
registerPreloadErrorGuard();

// Initialize Amplify before rendering the app
initializeAmplify().then((configured) => {
  if (!configured) {
    console.warn('Running without AWS configuration. Some features may not work.');
  }
  
  createRoot(document.getElementById('root')!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
});
