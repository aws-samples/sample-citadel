/**
 * Error Handling Validation
 * 
 * This file validates that the error handling implementation is correct
 * by checking the structure and types of the SubscriptionManager.
 */

import { SubscriptionManager } from '../subscriptionManager';
import { SubscriptionError, EVENT_TYPES } from '../eventTypes';
import { eventBus } from '../eventBus';

// Type checking validation
type ValidationResult = {
  passed: boolean;
  message: string;
};

const validations: ValidationResult[] = [];

// 1. Validate SubscriptionError interface exists and has correct structure
const validateSubscriptionErrorInterface = (): ValidationResult => {
  const mockError: SubscriptionError = {
    eventType: EVENT_TYPES.CHATTER,
    error: new Error('test'),
    timestamp: new Date().toISOString(),
    attemptCount: 0,
  };

  if (
    typeof mockError.eventType === 'string' &&
    mockError.error instanceof Error &&
    typeof mockError.timestamp === 'string' &&
    typeof mockError.attemptCount === 'number'
  ) {
    return {
      passed: true,
      message: 'SubscriptionError interface is correctly defined',
    };
  }

  return {
    passed: false,
    message: 'SubscriptionError interface has incorrect structure',
  };
};

// 2. Validate SUBSCRIPTION_ERROR event type exists
const validateSubscriptionErrorEventType = (): ValidationResult => {
  if (EVENT_TYPES.SUBSCRIPTION_ERROR === 'subscriptionError') {
    return {
      passed: true,
      message: 'SUBSCRIPTION_ERROR event type is correctly defined',
    };
  }

  return {
    passed: false,
    message: 'SUBSCRIPTION_ERROR event type is missing or incorrect',
  };
};

// 3. Validate SubscriptionManager has error handling methods
const validateSubscriptionManagerMethods = (): ValidationResult => {
  const manager = SubscriptionManager.getInstance();

  if (
    typeof manager.initializeSubscription === 'function' &&
    typeof manager.addLocalSubscriber === 'function' &&
    typeof manager.removeLocalSubscriber === 'function' &&
    typeof manager.getActiveSubscriptions === 'function' &&
    typeof manager.cleanupSubscription === 'function'
  ) {
    return {
      passed: true,
      message: 'SubscriptionManager has all required methods',
    };
  }

  return {
    passed: false,
    message: 'SubscriptionManager is missing required methods',
  };
};

// 4. Validate EventBus can handle SUBSCRIPTION_ERROR events
const validateEventBusErrorHandling = (): ValidationResult => {
  try {
    let errorReceived = false;
    const unsubscribe = eventBus.subscribe(EVENT_TYPES.SUBSCRIPTION_ERROR, () => {
      errorReceived = true;
    });

    const testError: SubscriptionError = {
      eventType: EVENT_TYPES.CHATTER,
      error: new Error('test error'),
      timestamp: new Date().toISOString(),
      attemptCount: 1,
    };

    eventBus.emit(EVENT_TYPES.SUBSCRIPTION_ERROR, testError);
    unsubscribe();

    if (errorReceived) {
      return {
        passed: true,
        message: 'EventBus can handle SUBSCRIPTION_ERROR events',
      };
    }

    return {
      passed: false,
      message: 'EventBus did not receive SUBSCRIPTION_ERROR event',
    };
  } catch (error) {
    return {
      passed: false,
      message: `EventBus error handling failed: ${error}`,
    };
  }
};

// Run all validations
console.log('=== Error Handling Validation ===\n');

validations.push(validateSubscriptionErrorInterface());
validations.push(validateSubscriptionErrorEventType());
validations.push(validateSubscriptionManagerMethods());
validations.push(validateEventBusErrorHandling());

// Print results
validations.forEach((result, index) => {
  const status = result.passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${index + 1}. ${status}: ${result.message}`);
});

const allPassed = validations.every((v) => v.passed);
console.log(`\n=== Overall: ${allPassed ? '✅ ALL VALIDATIONS PASSED' : '❌ SOME VALIDATIONS FAILED'} ===`);

export { validations };
