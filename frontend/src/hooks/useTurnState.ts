/**
 * useTurnState — Per-turn state machine for the intake chat.
 *
 * Phases:
 *   idle → sending → awaitingAck → awaitingReply → done
 *                  ↘ ackTimeout ──────────────────↗
 *                               ↘ replyTimeout ──↗
 *                                  ↘ failed ─────↗
 *
 * Timers:
 *   T1 (8 s) – from mutation resolve to TURN_ACCEPTED.
 *   T2 (90 s) – from ack (or T1 expiry) to AGENT_RESPONSE.
 *     Reset on PROGRESS_UPDATE; hard cap 5 min from first T2 arm.
 */
import { useRef, useMemo } from 'react';
import { useSyncExternalStore } from 'react';

// ── constants ──────────────────────────────────────────────────────────
export const T1_MS = 8_000;
export const T2_MS = 90_000;
export const T2_HARD_CAP_MS = 5 * 60_000; // 5 minutes

// ── types ──────────────────────────────────────────────────────────────
export type TurnPhase =
  | 'idle'
  | 'sending'
  | 'awaitingAck'
  | 'awaitingReply'
  | 'done'
  | 'ackTimeout'
  | 'replyTimeout'
  | 'failed';

export interface TurnSnapshot {
  phase: TurnPhase;
  clientMessageId: string | null;
  /** The user text that was (or will be re-) sent. */
  pendingText: string | null;
  /** Human-readable status text for inline display. */
  statusText: string | null;
}

const IDLE_SNAPSHOT: TurnSnapshot = {
  phase: 'idle',
  clientMessageId: null,
  pendingText: null,
  statusText: null,
};

// ── store (external, so useSyncExternalStore keeps renders in sync) ───
type Listener = () => void;

class TurnStore {
  private snap: TurnSnapshot = { ...IDLE_SNAPSHOT };
  private listeners = new Set<Listener>();
  private t1: ReturnType<typeof setTimeout> | null = null;
  private t2: ReturnType<typeof setTimeout> | null = null;
  private t2HardCap: ReturnType<typeof setTimeout> | null = null;

  getSnapshot = (): TurnSnapshot => this.snap;

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  private set(partial: Partial<TurnSnapshot>) {
    this.snap = { ...this.snap, ...partial };
    this.listeners.forEach((l) => l());
  }

  // ── timer helpers ──────────────────────────────────────────────────
  private clearT1() {
    if (this.t1 !== null) { clearTimeout(this.t1); this.t1 = null; }
  }

  private clearT2() {
    if (this.t2 !== null) { clearTimeout(this.t2); this.t2 = null; }
    if (this.t2HardCap !== null) { clearTimeout(this.t2HardCap); this.t2HardCap = null; }
  }

  clearAll() {
    this.clearT1();
    this.clearT2();
  }

  // ── public transitions ─────────────────────────────────────────────

  /** User clicked Send (or Retry). */
  markSending(clientMessageId: string, text: string) {
    this.clearAll();
    this.set({ phase: 'sending', clientMessageId, pendingText: text, statusText: null });
  }

  /** The mutation promise resolved — message stored server-side. */
  markSent() {
    if (this.snap.phase !== 'sending') return;
    this.set({ phase: 'awaitingAck', statusText: null });
    this.t1 = setTimeout(() => this.onT1Expired(), T1_MS);
  }

  /** Mutation threw. */
  markFailed(errorMsg: string) {
    this.clearAll();
    this.set({ phase: 'failed', statusText: errorMsg });
  }

  /** TURN_ACCEPTED subscription message received. */
  onAck() {
    if (this.snap.phase !== 'awaitingAck' && this.snap.phase !== 'ackTimeout') return;
    this.clearT1();
    this.set({ phase: 'awaitingReply', statusText: null });
    this.armT2();
  }

  /** PROGRESS_UPDATE received — reset T2 (but not the hard cap). */
  onProgress() {
    if (this.snap.phase !== 'awaitingReply' && this.snap.phase !== 'awaitingAck' && this.snap.phase !== 'ackTimeout') return;
    // If we're still in awaitingAck/ackTimeout, this proves the handler is alive — promote to awaitingReply.
    if (this.snap.phase === 'awaitingAck' || this.snap.phase === 'ackTimeout') {
      this.clearT1();
    }
    this.set({ phase: 'awaitingReply', statusText: null });
    // Reset soft T2 but keep hard cap.
    if (this.t2 !== null) { clearTimeout(this.t2); }
    this.t2 = setTimeout(() => this.onT2Expired(), T2_MS);
  }

  /** AGENT_RESPONSE received — turn complete. */
  onReply() {
    this.clearAll();
    this.set({ phase: 'done', statusText: null, pendingText: null, clientMessageId: null });
    // Immediately go idle so the next send is unblocked.
    this.set({ ...IDLE_SNAPSHOT });
  }

  /** Reset to idle (e.g. on component unmount). */
  reset() {
    this.clearAll();
    this.set({ ...IDLE_SNAPSHOT });
  }

  // ── private timer callbacks ────────────────────────────────────────
  private onT1Expired() {
    this.t1 = null;
    this.set({
      phase: 'ackTimeout',
      statusText: 'Still waiting for the agent to pick this up',
    });
    // Optimistic: the mutation DID succeed, so start T2.
    this.armT2();
  }

  private onT2Expired() {
    this.t2 = null;
    if (this.t2HardCap !== null) { clearTimeout(this.t2HardCap); this.t2HardCap = null; }
    this.set({
      phase: 'replyTimeout',
      statusText: 'No response. The request may have been lost.',
    });
  }

  private armT2() {
    // Only arm once (the hard cap persists across soft resets).
    if (this.t2HardCap === null) {
      this.t2HardCap = setTimeout(() => this.onT2Expired(), T2_HARD_CAP_MS);
    }
    if (this.t2 !== null) { clearTimeout(this.t2); }
    this.t2 = setTimeout(() => this.onT2Expired(), T2_MS);
  }
}

// ── React hook ─────────────────────────────────────────────────────────
export function useTurnState() {
  const storeRef = useRef<TurnStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new TurnStore();
  }
  const store = storeRef.current;

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const actions = useMemo(() => ({
    markSending: (id: string, text: string) => store.markSending(id, text),
    markSent: () => store.markSent(),
    markFailed: (msg: string) => store.markFailed(msg),
    onAck: () => store.onAck(),
    onProgress: () => store.onProgress(),
    onReply: () => store.onReply(),
    reset: () => store.reset(),
  }), [store]);

  return [snap, actions] as const;
}
