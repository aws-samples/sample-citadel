/**
 * useGovernanceMode — reads the app-wide governance mode from context.
 *
 * The actual polling lives in GovernanceModeProvider (mounted once in App.tsx).
 * This hook is a thin context accessor so existing consumers (ModeBadge,
 * ModeCard, GovernanceOverview) keep the same return shape with zero code
 * changes.
 */

import { useContext } from 'react';
import {
  GovernanceModeContext,
  GovernanceModeState,
} from '../contexts/GovernanceModeContext';

export type UseGovernanceModeResult = GovernanceModeState;

export function useGovernanceMode(): UseGovernanceModeResult {
  return useContext(GovernanceModeContext);
}

export default useGovernanceMode;
