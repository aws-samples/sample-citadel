/**
 * Tests for shared ingestion side-effects (EventBridge emit shape).
 *
 * Finding #1: emitAssessmentTrigger must use a DETERMINISTIC messageId derived
 * from the document identity so that duplicate emits (the poller emits the
 * trigger BEFORE the conditional `triggered=true` claim, so overlapping runs
 * can emit twice) collapse to a single logical message downstream.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const eventBridgeMock = mockClient(EventBridgeClient);

import {
  emitAssessmentTrigger,
  isDocumentAbsent,
  classifyStatus,
  isTerminal,
  FAILED_STATUSES,
} from '../document-ingestion-shared';

function emittedDetail(callIndex: number): Record<string, unknown> {
  const calls = eventBridgeMock.commandCalls(PutEventsCommand);
  return JSON.parse(calls[callIndex].args[0].input.Entries![0].Detail as string);
}

describe('emitAssessmentTrigger deterministic messageId (Finding #1)', () => {
  beforeEach(() => {
    eventBridgeMock.reset();
    eventBridgeMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
  });

  test('messageId is derived deterministically from projectId + documentKey', async () => {
    await emitAssessmentTrigger('proj-1', 'proj-1/a.pdf', 'a.pdf', 2048, 'application/pdf');
    expect(emittedDetail(0).messageId).toBe('doc-indexed-proj-1-proj-1/a.pdf');
  });

  test('two emits for the same document share the same messageId', async () => {
    await emitAssessmentTrigger('proj-1', 'proj-1/a.pdf', 'a.pdf', 2048, 'application/pdf');
    await emitAssessmentTrigger('proj-1', 'proj-1/a.pdf', 'a.pdf', 2048, 'application/pdf');
    expect(emittedDetail(0).messageId).toBe(emittedDetail(1).messageId);
  });

  test('distinct documents produce distinct messageIds', async () => {
    await emitAssessmentTrigger('proj-1', 'proj-1/a.pdf', 'a.pdf', 1, 'application/pdf');
    await emitAssessmentTrigger('proj-1', 'proj-1/b.pdf', 'b.pdf', 1, 'application/pdf');
    expect(emittedDetail(0).messageId).not.toBe(emittedDetail(1).messageId);
  });

  test('other detail fields are unchanged (shape preserved)', async () => {
    await emitAssessmentTrigger('proj-1', 'proj-1/a.pdf', 'a.pdf', 2048, 'application/pdf');
    const detail = emittedDetail(0);
    expect(detail.projectId).toBe('proj-1');
    expect(detail.agentId).toBe('agent_intake_single');
    expect(detail.userId).toBe('system');
    expect(detail.metadata).toEqual({ documentKey: 'proj-1/a.pdf', trigger: 'document_indexed' });
  });
});

describe('isDocumentAbsent (Finding #2 helper)', () => {
  test('absent when polled status missing/empty/NOT_FOUND or not returned', () => {
    expect(isDocumentAbsent(undefined)).toBe(true);
    expect(isDocumentAbsent({ status: '' })).toBe(true);
    expect(isDocumentAbsent({ status: 'NOT_FOUND' })).toBe(true);
  });

  test('present when polled status is a real Bedrock status', () => {
    expect(isDocumentAbsent({ status: 'IN_PROGRESS' })).toBe(false);
    expect(isDocumentAbsent({ status: 'INDEXED' })).toBe(false);
  });
});

describe('IGNORED is a Bedrock dedup/no-op, not a failure', () => {
  test("classifyStatus('IGNORED') is TRANSIENT (poll for the real status)", () => {
    expect(classifyStatus('IGNORED')).toBe('TRANSIENT');
  });

  test("isTerminal('IGNORED') is false (keep re-polling)", () => {
    expect(isTerminal('IGNORED')).toBe(false);
  });

  test('IGNORED is not in FAILED_STATUSES', () => {
    expect(FAILED_STATUSES.has('IGNORED')).toBe(false);
  });

  test('genuine hard failures remain FAILED', () => {
    expect(classifyStatus('FAILED')).toBe('FAILED');
    expect(classifyStatus('METADATA_UPDATE_FAILED')).toBe('FAILED');
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('METADATA_UPDATE_FAILED')).toBe(true);
  });

  test('INDEXED/PARTIALLY_INDEXED remain SUCCESS', () => {
    expect(classifyStatus('INDEXED')).toBe('SUCCESS');
    expect(classifyStatus('PARTIALLY_INDEXED')).toBe('SUCCESS');
  });
});
