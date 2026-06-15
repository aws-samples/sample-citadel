// build: 2026-03-17T23:20
console.info('[citadel] build 20260317.2320');
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import './styles/custom.css';
import './styles/workflow.css';
import { initializeAmplify } from './config/amplify';
import { initializeSubscriptionDebug } from './services/subscriptionDebug';

// Initialize subscription debug tools in development mode
initializeSubscriptionDebug();

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
