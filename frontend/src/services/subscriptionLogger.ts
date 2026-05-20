/**
 * Subscription Logger
 * 
 * Production-safe logging and monitoring for subscription system.
 * Implements log level filtering, metrics tracking, and error tracking integration.
 * 
 * Requirements: 7.3, 7.5
 */

import { EventType } from './eventTypes';

/**
 * Log levels in order of severity
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

/**
 * Subscription metrics tracked over time
 */
export interface SubscriptionMetrics {
  // Connection metrics
  totalBackendConnections: number;
  totalLocalSubscribers: number;
  connectionsByEventType: Map<EventType, number>;
  subscribersByEventType: Map<EventType, number>;
  
  // Event metrics
  eventsEmittedTotal: number;
  eventsEmittedByType: Map<EventType, number>;
  
  // Error metrics
  errorsTotal: number;
  errorsByEventType: Map<EventType, number>;
  reconnectionAttempts: number;
  reconnectionSuccesses: number;
  reconnectionFailures: number;
  
  // Timing metrics
  lastMetricsReset: Date;
  lastEventTimestamp: Date | null;
}

/**
 * Error tracking integration interface
 * Allows integration with services like Sentry, Datadog, etc.
 */
export interface ErrorTracker {
  captureError(error: Error, context: Record<string, any>): void;
  captureMessage(message: string, level: 'info' | 'warning' | 'error', context: Record<string, any>): void;
}

/**
 * Subscription logger configuration
 */
interface LoggerConfig {
  logLevel: LogLevel;
  enableMetrics: boolean;
  metricsInterval: number; // milliseconds
  errorTracker: ErrorTracker | null;
  sanitizeData: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
  logLevel: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.DEBUG,
  enableMetrics: true,
  metricsInterval: 300000, // 5 minutes
  errorTracker: null,
  sanitizeData: process.env.NODE_ENV === 'production',
};

/**
 * Subscription Logger class
 * Singleton that manages logging and metrics for the subscription system
 */
class SubscriptionLogger {
  private static instance: SubscriptionLogger | null = null;
  private config: LoggerConfig;
  private metrics: SubscriptionMetrics;
  private metricsTimer: NodeJS.Timeout | null = null;

  private constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = this.createEmptyMetrics();
    
    if (this.config.enableMetrics) {
      this.startMetricsLogging();
    }
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(config?: Partial<LoggerConfig>): SubscriptionLogger {
    if (!SubscriptionLogger.instance) {
      SubscriptionLogger.instance = new SubscriptionLogger(config);
    }
    return SubscriptionLogger.instance;
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): SubscriptionMetrics {
    return {
      totalBackendConnections: 0,
      totalLocalSubscribers: 0,
      connectionsByEventType: new Map(),
      subscribersByEventType: new Map(),
      eventsEmittedTotal: 0,
      eventsEmittedByType: new Map(),
      errorsTotal: 0,
      errorsByEventType: new Map(),
      reconnectionAttempts: 0,
      reconnectionSuccesses: 0,
      reconnectionFailures: 0,
      lastMetricsReset: new Date(),
      lastEventTimestamp: null,
    };
  }

  /**
   * Update configuration
   */
  public configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Restart metrics logging if interval changed
    if (config.metricsInterval !== undefined || config.enableMetrics !== undefined) {
      this.stopMetricsLogging();
      if (this.config.enableMetrics) {
        this.startMetricsLogging();
      }
    }
  }

  /**
   * Set error tracker for integration with external services
   */
  public setErrorTracker(tracker: ErrorTracker): void {
    this.config.errorTracker = tracker;
  }

  /**
   * Set log level
   */
  public setLogLevel(level: LogLevel): void {
    this.config.logLevel = level;
  }

  /**
   * Get current log level
   */
  public getLogLevel(): LogLevel {
    return this.config.logLevel;
  }

  /**
   * Check if a log level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.logLevel;
  }

  /**
   * Sanitize data to remove sensitive information
   * In production, this removes potentially sensitive fields
   */
  private sanitizeData(data: any): any {
    if (!this.config.sanitizeData) {
      return data;
    }

    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data !== 'object') {
      return data;
    }

    // Create a shallow copy
    const sanitized: any = Array.isArray(data) ? [...data] : { ...data };

    // List of sensitive field names to redact
    const sensitiveFields = [
      'password',
      'token',
      'apiKey',
      'secret',
      'authorization',
      'cookie',
      'session',
      'credentials',
      'email',
      'phone',
      'ssn',
      'creditCard',
    ];

    // Recursively sanitize object
    for (const key in sanitized) {
      if (sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeData(sanitized[key]);
      }
    }

    return sanitized;
  }

  /**
   * Format log message with timestamp and context
   */
  private formatMessage(level: string, message: string, context?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(this.sanitizeData(context))}` : '';
    return `[${timestamp}] [${level}] [Subscription] ${message}${contextStr}`;
  }

  /**
   * Log debug message
   */
  public debug(message: string, context?: Record<string, any>): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(this.formatMessage('DEBUG', message, context));
    }
  }

  /**
   * Log info message
   */
  public info(message: string, context?: Record<string, any>): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(this.formatMessage('INFO', message, context));
    }
  }

  /**
   * Log warning message
   */
  public warn(message: string, context?: Record<string, any>): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage('WARN', message, context));
    }

    // Send to error tracker if configured
    if (this.config.errorTracker) {
      this.config.errorTracker.captureMessage(
        message,
        'warning',
        this.sanitizeData(context || {})
      );
    }
  }

  /**
   * Log error message
   * Requirement 7.5: Log detailed error information including event type and subscriber count
   */
  public error(
    message: string,
    error?: Error,
    context?: Record<string, any>
  ): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorContext = {
        ...context,
        error: error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : undefined,
      };
      console.error(this.formatMessage('ERROR', message, errorContext));
    }

    // Track error in metrics
    if (context?.eventType) {
      this.trackError(context.eventType as EventType);
    } else {
      this.metrics.errorsTotal++;
    }

    // Send to error tracker if configured
    if (this.config.errorTracker && error) {
      this.config.errorTracker.captureError(
        error,
        this.sanitizeData(context || {})
      );
    }
  }

  /**
   * Track backend connection created
   */
  public trackConnectionCreated(eventType: EventType): void {
    this.metrics.totalBackendConnections++;
    const current = this.metrics.connectionsByEventType.get(eventType) || 0;
    this.metrics.connectionsByEventType.set(eventType, current + 1);
    
    this.debug(`Backend connection created for ${eventType}`, {
      eventType,
      totalConnections: this.metrics.totalBackendConnections,
    });
  }

  /**
   * Track backend connection closed
   */
  public trackConnectionClosed(eventType: EventType): void {
    this.metrics.totalBackendConnections = Math.max(0, this.metrics.totalBackendConnections - 1);
    const current = this.metrics.connectionsByEventType.get(eventType) || 0;
    this.metrics.connectionsByEventType.set(eventType, Math.max(0, current - 1));
    
    this.debug(`Backend connection closed for ${eventType}`, {
      eventType,
      totalConnections: this.metrics.totalBackendConnections,
    });
  }

  /**
   * Track local subscriber added
   */
  public trackSubscriberAdded(eventType: EventType): void {
    this.metrics.totalLocalSubscribers++;
    const current = this.metrics.subscribersByEventType.get(eventType) || 0;
    this.metrics.subscribersByEventType.set(eventType, current + 1);
    
    this.debug(`Local subscriber added for ${eventType}`, {
      eventType,
      totalSubscribers: this.metrics.totalLocalSubscribers,
      eventTypeSubscribers: current + 1,
    });
  }

  /**
   * Track local subscriber removed
   */
  public trackSubscriberRemoved(eventType: EventType): void {
    this.metrics.totalLocalSubscribers = Math.max(0, this.metrics.totalLocalSubscribers - 1);
    const current = this.metrics.subscribersByEventType.get(eventType) || 0;
    this.metrics.subscribersByEventType.set(eventType, Math.max(0, current - 1));
    
    this.debug(`Local subscriber removed for ${eventType}`, {
      eventType,
      totalSubscribers: this.metrics.totalLocalSubscribers,
      eventTypeSubscribers: Math.max(0, current - 1),
    });
  }

  /**
   * Track event emitted
   */
  public trackEventEmitted(eventType: EventType, subscriberCount: number): void {
    this.metrics.eventsEmittedTotal++;
    const current = this.metrics.eventsEmittedByType.get(eventType) || 0;
    this.metrics.eventsEmittedByType.set(eventType, current + 1);
    this.metrics.lastEventTimestamp = new Date();
    
    this.debug(`Event emitted for ${eventType}`, {
      eventType,
      subscriberCount,
      totalEvents: this.metrics.eventsEmittedTotal,
    });
  }

  /**
   * Track error occurred
   */
  public trackError(eventType: EventType): void {
    this.metrics.errorsTotal++;
    const current = this.metrics.errorsByEventType.get(eventType) || 0;
    this.metrics.errorsByEventType.set(eventType, current + 1);
  }

  /**
   * Track reconnection attempt
   */
  public trackReconnectionAttempt(eventType: EventType, attemptNumber: number): void {
    this.metrics.reconnectionAttempts++;
    
    this.info(`Reconnection attempt for ${eventType}`, {
      eventType,
      attemptNumber,
      totalAttempts: this.metrics.reconnectionAttempts,
    });
  }

  /**
   * Track reconnection success
   */
  public trackReconnectionSuccess(eventType: EventType): void {
    this.metrics.reconnectionSuccesses++;
    
    this.info(`Reconnection successful for ${eventType}`, {
      eventType,
      totalSuccesses: this.metrics.reconnectionSuccesses,
    });
  }

  /**
   * Track reconnection failure
   */
  public trackReconnectionFailure(eventType: EventType, error: Error): void {
    this.metrics.reconnectionFailures++;
    
    this.error(`Reconnection failed for ${eventType}`, error, {
      eventType,
      totalFailures: this.metrics.reconnectionFailures,
    });
  }

  /**
   * Get current metrics snapshot
   */
  public getMetrics(): SubscriptionMetrics {
    return {
      ...this.metrics,
      connectionsByEventType: new Map(this.metrics.connectionsByEventType),
      subscribersByEventType: new Map(this.metrics.subscribersByEventType),
      eventsEmittedByType: new Map(this.metrics.eventsEmittedByType),
      errorsByEventType: new Map(this.metrics.errorsByEventType),
    };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
    this.info('Metrics reset');
  }

  /**
   * Start periodic metrics logging
   * Requirement 7.3: Log subscription metrics every 5 minutes in production
   */
  private startMetricsLogging(): void {
    if (this.metricsTimer) {
      return;
    }

    this.metricsTimer = setInterval(() => {
      this.logMetricsSummary();
    }, this.config.metricsInterval);
  }

  /**
   * Stop periodic metrics logging
   */
  private stopMetricsLogging(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  /**
   * Log metrics summary
   * Requirement 7.3: Log subscription metrics in production
   */
  public logMetricsSummary(): void {
    const timeSinceReset = Date.now() - this.metrics.lastMetricsReset.getTime();
    const minutesSinceReset = Math.floor(timeSinceReset / 60000);

    const summary = {
      period: `${minutesSinceReset} minutes`,
      connections: {
        total: this.metrics.totalBackendConnections,
        byEventType: Object.fromEntries(this.metrics.connectionsByEventType),
      },
      subscribers: {
        total: this.metrics.totalLocalSubscribers,
        byEventType: Object.fromEntries(this.metrics.subscribersByEventType),
      },
      events: {
        total: this.metrics.eventsEmittedTotal,
        byEventType: Object.fromEntries(this.metrics.eventsEmittedByType),
      },
      errors: {
        total: this.metrics.errorsTotal,
        byEventType: Object.fromEntries(this.metrics.errorsByEventType),
      },
      reconnections: {
        attempts: this.metrics.reconnectionAttempts,
        successes: this.metrics.reconnectionSuccesses,
        failures: this.metrics.reconnectionFailures,
      },
      lastEvent: this.metrics.lastEventTimestamp?.toISOString() || 'never',
    };

    this.info('Subscription metrics summary', summary);
  }

  /**
   * Cleanup and stop logging
   */
  public destroy(): void {
    this.stopMetricsLogging();
  }
}

// Export singleton instance
export const subscriptionLogger = SubscriptionLogger.getInstance();

// Export class for testing
export { SubscriptionLogger };
