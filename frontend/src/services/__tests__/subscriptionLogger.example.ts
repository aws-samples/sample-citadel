/**
 * Subscription Logger Usage Examples
 * 
 * This file demonstrates how to use the subscription logger in various scenarios.
 * These are examples, not actual tests.
 */

import { subscriptionLogger, LogLevel, ErrorTracker } from '../subscriptionLogger';
import { EVENT_TYPES } from '../eventTypes';

// Example 1: Basic logging at different levels
export function exampleBasicLogging() {
  // Debug message (only in development)
  subscriptionLogger.debug('Initializing subscription system');

  // Info message
  subscriptionLogger.info('Subscription system ready', {
    version: '1.0.0',
    environment: process.env.NODE_ENV,
  });

  // Warning message
  subscriptionLogger.warn('High subscriber count detected', {
    eventType: EVENT_TYPES.CHATTER,
    subscriberCount: 100,
  });

  // Error message
  const error = new Error('Connection failed');
  subscriptionLogger.error(
    'Failed to establish backend connection',
    error,
    {
      eventType: EVENT_TYPES.CHATTER,
      subscriberCount: 5,
      attemptNumber: 3,
    }
  );
}

// Example 2: Configuring log level for different environments
export function exampleConfigureLogLevel() {
  if (process.env.NODE_ENV === 'production') {
    // In production, only log warnings and errors
    subscriptionLogger.setLogLevel(LogLevel.WARN);
  } else if (process.env.NODE_ENV === 'test') {
    // In tests, disable all logging
    subscriptionLogger.setLogLevel(LogLevel.NONE);
  } else {
    // In development, log everything
    subscriptionLogger.setLogLevel(LogLevel.DEBUG);
  }
}

// Example 3: Configuring metrics
export function exampleConfigureMetrics() {
  // Enable metrics with custom interval
  subscriptionLogger.configure({
    enableMetrics: true,
    metricsInterval: 60000, // Log metrics every minute
  });

  // Disable metrics
  subscriptionLogger.configure({
    enableMetrics: false,
  });

  // Change multiple settings at once
  subscriptionLogger.configure({
    logLevel: LogLevel.INFO,
    enableMetrics: true,
    metricsInterval: 300000, // 5 minutes
    sanitizeData: true,
  });
}

// Example 4: Integrating with error tracking service (Sentry)
export function exampleErrorTrackerIntegration() {
  // Mock Sentry for example purposes
  const mockSentry = {
    captureException: (error: Error, options: any) => {
      console.log('Sentry captured exception:', error.message, options);
    },
    captureMessage: (message: string, options: any) => {
      console.log('Sentry captured message:', message, options);
    },
  };

  // Create error tracker adapter
  const sentryTracker: ErrorTracker = {
    captureError(error: Error, context: Record<string, any>) {
      mockSentry.captureException(error, { extra: context });
    },
    captureMessage(message: string, level: 'info' | 'warning' | 'error', context: Record<string, any>) {
      mockSentry.captureMessage(message, { level, extra: context });
    },
  };

  // Set the error tracker
  subscriptionLogger.setErrorTracker(sentryTracker);

  // Now all errors and warnings will be sent to Sentry
  subscriptionLogger.error(
    'Critical subscription error',
    new Error('WebSocket closed unexpectedly'),
    { eventType: EVENT_TYPES.CHATTER }
  );
}

// Example 5: Tracking metrics manually
export function exampleTrackingMetrics() {
  // Track connection created
  subscriptionLogger.trackConnectionCreated(EVENT_TYPES.CHATTER);

  // Track subscriber added
  subscriptionLogger.trackSubscriberAdded(EVENT_TYPES.CHATTER);

  // Track event emitted
  subscriptionLogger.trackEventEmitted(EVENT_TYPES.CHATTER, 5);

  // Track error
  subscriptionLogger.trackError(EVENT_TYPES.CHATTER);

  // Track reconnection attempt
  subscriptionLogger.trackReconnectionAttempt(EVENT_TYPES.CHATTER, 1);

  // Track reconnection success
  subscriptionLogger.trackReconnectionSuccess(EVENT_TYPES.CHATTER);

  // Track reconnection failure
  subscriptionLogger.trackReconnectionFailure(
    EVENT_TYPES.CHATTER,
    new Error('Max retries exceeded')
  );

  // Track subscriber removed
  subscriptionLogger.trackSubscriberRemoved(EVENT_TYPES.CHATTER);

  // Track connection closed
  subscriptionLogger.trackConnectionClosed(EVENT_TYPES.CHATTER);
}

// Example 6: Accessing and logging metrics
export function exampleAccessMetrics() {
  // Get current metrics snapshot
  const metrics = subscriptionLogger.getMetrics();
  
  console.log('Total backend connections:', metrics.totalBackendConnections);
  console.log('Total local subscribers:', metrics.totalLocalSubscribers);
  console.log('Total events emitted:', metrics.eventsEmittedTotal);
  console.log('Total errors:', metrics.errorsTotal);
  console.log('Reconnection attempts:', metrics.reconnectionAttempts);
  console.log('Reconnection successes:', metrics.reconnectionSuccesses);
  console.log('Reconnection failures:', metrics.reconnectionFailures);

  // Log metrics summary (formatted)
  subscriptionLogger.logMetricsSummary();

  // Reset metrics
  subscriptionLogger.resetMetrics();
}

// Example 7: Data sanitization
export function exampleDataSanitization() {
  // Enable sanitization (default in production)
  subscriptionLogger.configure({ sanitizeData: true });

  // This data will be sanitized before logging
  const sensitiveData = {
    username: 'john',
    password: 'secret123',
    email: 'john@example.com',
    apiKey: 'abc123',
    normalField: 'this is fine',
  };

  subscriptionLogger.info('User data', sensitiveData);
  // Logged as: { username: 'john', password: '[REDACTED]', email: '[REDACTED]', apiKey: '[REDACTED]', normalField: 'this is fine' }

  // Disable sanitization (for development)
  subscriptionLogger.configure({ sanitizeData: false });

  subscriptionLogger.info('User data', sensitiveData);
  // Logged as-is: { username: 'john', password: 'secret123', email: 'john@example.com', ... }
}

// Example 8: Production setup
export function exampleProductionSetup() {
  if (process.env.NODE_ENV === 'production') {
    // Configure for production
    subscriptionLogger.configure({
      logLevel: LogLevel.WARN, // Only warnings and errors
      enableMetrics: true,
      metricsInterval: 300000, // 5 minutes
      sanitizeData: true, // Sanitize sensitive data
    });

    // Set up error tracking (example with mock Sentry)
    const sentryTracker: ErrorTracker = {
      captureError(error, context) {
        // Send to Sentry
        console.log('Sentry:', error, context);
      },
      captureMessage(message, level, context) {
        // Send to Sentry
        console.log('Sentry:', message, level, context);
      },
    };

    subscriptionLogger.setErrorTracker(sentryTracker);

    console.log('Production logging configured');
  }
}

// Example 9: Development debugging
export function exampleDevelopmentDebugging() {
  if (process.env.NODE_ENV === 'development') {
    // Configure for development
    subscriptionLogger.configure({
      logLevel: LogLevel.DEBUG, // Log everything
      enableMetrics: true,
      metricsInterval: 60000, // 1 minute for faster feedback
      sanitizeData: false, // Don't sanitize in dev
    });

    // Use debug console commands
    console.log('Available debug commands:');
    console.log('  __subscriptionDebug.getMetrics()');
    console.log('  __subscriptionDebug.logMetricsSummary()');
    console.log('  __subscriptionDebug.resetMetrics()');
  }
}

// Example 10: Monitoring subscription health
export function exampleMonitoringHealth() {
  const metrics = subscriptionLogger.getMetrics();

  // Check for high error rate
  const errorRate = metrics.errorsTotal / Math.max(metrics.eventsEmittedTotal, 1);
  if (errorRate > 0.05) { // More than 5% errors
    console.warn('High error rate detected:', errorRate);
  }

  // Check for reconnection issues
  const reconnectionFailureRate = 
    metrics.reconnectionFailures / Math.max(metrics.reconnectionAttempts, 1);
  if (reconnectionFailureRate > 0.5) { // More than 50% failures
    console.error('High reconnection failure rate:', reconnectionFailureRate);
  }

  // Check for stale connections
  if (metrics.lastEventTimestamp) {
    const timeSinceLastEvent = Date.now() - metrics.lastEventTimestamp.getTime();
    if (timeSinceLastEvent > 600000) { // 10 minutes
      console.warn('No events received in 10 minutes');
    }
  }

  // Check for connection leaks
  if (metrics.totalBackendConnections > 10) {
    console.warn('High number of backend connections:', metrics.totalBackendConnections);
  }
}
