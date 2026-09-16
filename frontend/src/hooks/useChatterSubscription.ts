import { useEffect, useRef } from 'react';
import { subscribeToChatter, type ChatterMessage } from '@/services/chatterService';
import { useOrganization } from '@/contexts/OrganizationContext';

export function useChatterSubscription(
  onMessage: (message: ChatterMessage) => void,
  enabled: boolean = true
) {
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const onMessageRef = useRef(onMessage);
  // Caller's own organisation claim — never the org-selector filter value.
  // Admins have their own organisation too; the selector is a filter scope
  // for browsing other orgs' data, not an identity to subscribe as.
  const { currentUser } = useOrganization();
  const callerOrgId = currentUser?.organization ?? null;

  // Keep the callback ref up to date
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!enabled || !callerOrgId) {
      // Clean up existing subscription if disabled, or if no organisation
      // is available yet for this caller — never subscribe without one.
      if (unsubscribeRef.current) {
        console.log('Cleaning up chatter subscription (disabled or no organisation)...');
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
    }, callerOrgId);

    unsubscribeRef.current = unsubscribe;

    return () => {
      console.log('Cleaning up chatter subscription...');
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [enabled, callerOrgId]);

  return unsubscribeRef;
}
