/**
 * UserDisplayName Component
 *
 * A drop-in component that resolves a user ID (GUID) to a human-readable name.
 * Use this anywhere a user ID might be displayed to prevent raw GUIDs in the UI.
 *
 * Usage:
 *   <UserDisplayName userId={app.createdBy} />
 *   <UserDisplayName userId={app.createdBy} fallback="System" />
 *   <UserDisplayName userId={app.createdBy} prefix="Created by " />
 */
import { useUserDisplayName } from '../hooks/useUserDisplayName';

interface UserDisplayNameProps {
  /** The user ID (GUID) to resolve to a display name */
  userId: string | undefined | null;
  /** Optional prefix text (e.g., "Created by ") */
  prefix?: string;
  /** Optional suffix text */
  suffix?: string;
  /** Fallback text when userId is null/undefined. Default: "unknown" */
  fallback?: string;
  /** Optional CSS class name for the wrapping span */
  className?: string;
}

export function UserDisplayName({
  userId,
  prefix = '',
  suffix = '',
  fallback = 'unknown',
  className,
}: UserDisplayNameProps) {
  const displayName = useUserDisplayName(userId);
  const text = userId ? displayName : fallback;

  return (
    <span className={className}>
      {prefix}{text}{suffix}
    </span>
  );
}
