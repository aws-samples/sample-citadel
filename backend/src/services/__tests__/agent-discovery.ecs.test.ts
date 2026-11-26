/**
 * ECS additions to agent-discovery (US-IMP-018).
 *
 * ECS is a DISCOVERY SUBSTRATE: a pasted ECS SERVICE ARN now resolves to a
 * HTTP_ENDPOINT invocation on substrate 'ecs' (no longer UnsupportedSourceError),
 * and `getDiscoveryAdapterForSubstrate` dispatches the substrate to the
 * EcsSourceAdapter for describe/healthCheck. Non-service ECS ARNs (tasks, etc.)
 * stay UNSUPPORTED, and non-discovery substrates have no discovery adapter.
 */
import {
  resolveSourceRef,
  getDiscoveryAdapterForSubstrate,
  UnsupportedSourceError,
} from '../agent-discovery';
import { EcsSourceAdapter } from '../../adapters/agent-source/ecs-source-adapter';

const ECS_SERVICE_ARN =
  'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-agent-svc';
const ECS_SERVICE_ARN_OLD = 'arn:aws:ecs:us-east-1:123456789012:service/my-agent-svc';
const ECS_TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/my-cluster/abc123';

describe('resolveSourceRef — ECS service ARN (US-IMP-018)', () => {
  it.each([ECS_SERVICE_ARN, ECS_SERVICE_ARN_OLD])(
    'maps an ECS service ARN %s to { HTTP_ENDPOINT, ecs, <arn> }',
    (arn) => {
      const r = resolveSourceRef(arn);
      expect(r.protocol).toBe('HTTP_ENDPOINT');
      expect(r.substrate).toBe('ecs');
      expect(r.target).toBe(arn);
    },
  );

  it('still throws UnsupportedSourceError for a non-service ECS ARN (task)', () => {
    expect(() => resolveSourceRef(ECS_TASK_ARN)).toThrow(UnsupportedSourceError);
    expect(() => resolveSourceRef(ECS_TASK_ARN)).toThrow(/ecs not supported in phase 1/);
  });
});

describe('getDiscoveryAdapterForSubstrate (US-IMP-018)', () => {
  it("returns an EcsSourceAdapter for substrate 'ecs'", () => {
    const adapter = getDiscoveryAdapterForSubstrate('ecs');
    expect(adapter).toBeInstanceOf(EcsSourceAdapter);
  });

  it('threads a credentialProvider into the ECS adapter (cross-account describe)', () => {
    const credentialProvider = { accessKeyId: 'AKIA', secretAccessKey: 'secret' };
    const adapter = getDiscoveryAdapterForSubstrate('ecs', { credentialProvider });
    expect(adapter).toBeInstanceOf(EcsSourceAdapter);
  });

  it.each(['lambda', 'http', 'bedrock_agent', 'mcp', 'unknown'])(
    'returns undefined for non-discovery substrate %s',
    (substrate) => {
      expect(getDiscoveryAdapterForSubstrate(substrate)).toBeUndefined();
    },
  );
});
