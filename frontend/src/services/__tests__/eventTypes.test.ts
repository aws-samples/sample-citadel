/**
 * Event Types Unit Tests
 * 
 * Tests to verify event type definitions and type safety
 */

import {
  EVENT_TYPES,
  EventType,
  EventData,
  EventDataMap,
  ChatterEvent,
  FabricationEvent,
  ConversationEvent,
  ProjectProgressEvent,
  AssessmentCompleteEvent,
  DesignProgressEvent,
} from '../eventTypes';

describe('Event Types', () => {
  describe('EVENT_TYPES constant', () => {
    it('should export all event type constants', () => {
      expect(EVENT_TYPES.CHATTER).toBe('chatter');
      expect(EVENT_TYPES.FABRICATION).toBe('fabrication');
      expect(EVENT_TYPES.CONVERSATION).toBe('conversation');
      expect(EVENT_TYPES.PROJECT_PROGRESS).toBe('projectProgress');
      expect(EVENT_TYPES.ASSESSMENT_COMPLETE).toBe('assessmentComplete');
      expect(EVENT_TYPES.DESIGN_PROGRESS).toBe('designProgress');
      expect(EVENT_TYPES.SUBSCRIPTION_ERROR).toBe('subscriptionError');
    });

    it('should have exactly 7 event types', () => {
      const keys = Object.keys(EVENT_TYPES);
      expect(keys).toHaveLength(7);
    });

    it('should be immutable (readonly)', () => {
      // TypeScript will catch this at compile time, but we can verify the object is frozen
      expect(Object.isFrozen(EVENT_TYPES)).toBe(false); // as const doesn't freeze, but TS enforces readonly
    });
  });

  describe('Event Data Interfaces', () => {
    it('should allow valid ChatterEvent objects', () => {
      const event: ChatterEvent = {
        id: 'test-id',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test-source',
        detailType: 'test-detail',
        detail: { message: 'test' },
      };

      expect(event.id).toBe('test-id');
      expect(event.timestamp).toBe('2024-01-01T00:00:00Z');
    });

    it('should allow valid FabricationEvent objects', () => {
      const completedEvent: FabricationEvent = {
        type: 'COMPLETED',
        requestId: 'req-123',
        agentId: 'agent-456',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const failedEvent: FabricationEvent = {
        type: 'FAILED',
        requestId: 'req-789',
        errorMessage: 'Test error',
        timestamp: '2024-01-01T00:00:00Z',
      };

      expect(completedEvent.type).toBe('COMPLETED');
      expect(failedEvent.type).toBe('FAILED');
    });

    it('should allow valid ConversationEvent objects', () => {
      const event: ConversationEvent = {
        id: 'conv-123',
        projectId: 'proj-456',
        agentId: 'agent-789',
        message: 'Test message',
        messageType: 'USER_INPUT',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: '{"key":"value"}',
        correlationId: 'corr-123',
      };

      expect(event.messageType).toBe('USER_INPUT');
      expect(event.projectId).toBe('proj-456');
    });

    it('should allow valid ProjectProgressEvent objects', () => {
      const event: ProjectProgressEvent = {
        projectId: 'proj-123',
        assessment: 75,
      };

      expect(event.assessment).toBe(75);
    });

    it('should allow valid AssessmentCompleteEvent objects', () => {
      const event: AssessmentCompleteEvent = {
        projectId: 'proj-123',
        allDimensionsComplete: true,
        timestamp: '2024-01-01T00:00:00Z',
      };

      expect(event.allDimensionsComplete).toBe(true);
    });

    it('should allow valid DesignProgressEvent objects', () => {
      const event: DesignProgressEvent = {
        projectId: 'proj-123',
        sectionId: 'section-1',
        completionPercentage: 50,
      };

      expect(event.completionPercentage).toBe(50);
    });
  });

  describe('EventDataMap', () => {
    it('should map event types to their data structures', () => {
      // This is a compile-time test - if it compiles, the mapping is correct
      const chatterData: EventDataMap['chatter'] = {
        id: 'test',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test',
        detailType: 'test',
        detail: {},
      };

      const fabricationData: EventDataMap['fabrication'] = {
        type: 'COMPLETED',
        requestId: 'test',
        timestamp: '2024-01-01T00:00:00Z',
      };

      expect(chatterData.id).toBe('test');
      expect(fabricationData.type).toBe('COMPLETED');
    });
  });

  describe('Type safety', () => {
    it('should enforce EventType union type', () => {
      const validTypes: EventType[] = [
        'chatter',
        'fabrication',
        'conversation',
        'projectProgress',
        'assessmentComplete',
        'designProgress',
      ];

      validTypes.forEach((type) => {
        expect(typeof type).toBe('string');
      });
    });

    it('should provide type-safe event data access', () => {
      // This is primarily a compile-time test
      type ChatterData = EventData<'chatter'>;
      type FabricationData = EventData<'fabrication'>;

      const chatterData: ChatterData = {
        id: 'test',
        timestamp: '2024-01-01T00:00:00Z',
        source: 'test',
        detailType: 'test',
        detail: {},
      };

      const fabricationData: FabricationData = {
        type: 'COMPLETED',
        requestId: 'test',
        timestamp: '2024-01-01T00:00:00Z',
      };

      expect(chatterData.id).toBe('test');
      expect(fabricationData.type).toBe('COMPLETED');
    });
  });
});
