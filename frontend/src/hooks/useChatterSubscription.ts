import { useEffect, useRef } from 'react';
import { subscribeToChatter, type ChatterMessage } from '@/services/chatterService';

export function useChatterSubscription(
  onMessage: (message: ChatterMessage) => void,
  enabled: boolean = true
) {
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const onMessageRef = useRef(onMessage);

  // Keep the callback ref up to date
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!enabled) {
      // Clean up existing subscription if disabled
      if (unsubscribeRef.current) {
        console.log('Cleaning up chatter subscription (disabled)...');
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      return;
    }

    // Prevent duplicate subscriptions
    if (unsubscribeRef.current) {
      console.log('Chatter subscription already active, skipping...');
      return;
    }

    console.log('Setting up chatter subscription...');

    const unsubscribe = subscribeToChatter((message) => {
      console.log('Received chatter message:', message);
      onMessageRef.current(message);
    });

    unsubscribeRef.current = unsubscribe;

    return () => {
      console.log('Cleaning up chatter subscription...');
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [enabled]);

  return unsubscribeRef;
}
