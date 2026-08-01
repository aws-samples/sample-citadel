export enum LogLevel {
  ERROR = "ERROR",
  WARN = "WARN",
  INFO = "INFO",
  DEBUG = "DEBUG",
}

import * as AWSXRay from "aws-xray-sdk-core";

interface LogContext {
  requestId?: string;
  userId?: string;
  projectId?: string;
  agentId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

interface LogEntry extends LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
  trace_id?: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class Logger {
  private logLevel: LogLevel;

  constructor() {
    this.logLevel = this.parseLogLevel(process.env.LOG_LEVEL || "INFO");
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toUpperCase()) {
      case "ERROR":
        return LogLevel.ERROR;
      case "WARN":
        return LogLevel.WARN;
      case "INFO":
        return LogLevel.INFO;
      case "DEBUG":
        return LogLevel.DEBUG;
      default:
        return LogLevel.INFO;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [
      LogLevel.ERROR,
      LogLevel.WARN,
      LogLevel.INFO,
      LogLevel.DEBUG,
    ];
    return levels.indexOf(level) <= levels.indexOf(this.logLevel);
  }

  private formatLog(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error,
  ): string {
    // Additive, no-op-safe trace_id injection (design §"Annotation-key
    // contract" — every structured log line gets trace_id). Reading the
    // active X-Ray segment is guarded so a missing segment (Jest, cold
    // local invocation) never breaks logging.
    let trace_id: string | undefined;
    try {
      const segment = AWSXRay.getSegment();
      // A Subsegment carries the Root trace_id on its parent `.segment`,
      // not on itself; a root Segment carries it directly.
      const rootSegment = segment
        ? ((segment as { segment?: AWSXRay.Segment }).segment ??
          (segment as unknown as AWSXRay.Segment))
        : undefined;
      trace_id = rootSegment?.trace_id;
    } catch {
      trace_id = undefined;
    }

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(trace_id ? { trace_id } : {}),
      ...context,
    };

    if (error) {
      logEntry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return JSON.stringify(logEntry);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatLog(LogLevel.ERROR, message, context, error));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatLog(LogLevel.WARN, message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(this.formatLog(LogLevel.INFO, message, context));
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(this.formatLog(LogLevel.DEBUG, message, context));
    }
  }

  // Convenience methods for common logging scenarios
  logRequest(method: string, path: string, context?: LogContext): void {
    this.info(`${method} ${path}`, { ...context, type: "request" });
  }

  logResponse(
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    context?: LogContext,
  ): void {
    this.info(`${method} ${path} - ${statusCode}`, {
      ...context,
      type: "response",
      statusCode,
      duration,
    });
  }

  logAgentEvent(
    eventType: string,
    agentId: string,
    projectId: string,
    context?: LogContext,
  ): void {
    this.info(`Agent event: ${eventType}`, {
      ...context,
      type: "agent_event",
      eventType,
      agentId,
      projectId,
    });
  }

  logDatabaseOperation(
    operation: string,
    tableName: string,
    context?: LogContext,
  ): void {
    this.debug(`Database ${operation}`, {
      ...context,
      type: "database",
      operation,
      tableName,
    });
  }
}

export const logger = new Logger();

// Helper function to create context from Lambda event
export function createLogContext(event: unknown): LogContext {
  const e = event as {
    requestContext?: { requestId?: string };
    identity?: { sub?: string; username?: string };
    arguments?: { correlationId?: string };
  };
  return {
    requestId: e.requestContext?.requestId,
    userId: e.identity?.sub || e.identity?.username,
    correlationId: e.arguments?.correlationId,
  };
}
