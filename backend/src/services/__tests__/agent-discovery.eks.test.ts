/**
 * EKS additions to agent-discovery (US-IMP-019).
 *
 * EKS is a DISCOVERY SUBSTRATE: a pasted EKS CLUSTER ARN now resolves to a
 * HTTP_ENDPOINT invocation on substrate 'eks' (no longer UnsupportedSourceError),
 * and `getDiscoveryAdapterForSubstrate` dispatches the substrate to the
 * EksSourceAdapter for describe/healthCheck. Non-cluster EKS ARNs (nodegroup,
 * fargateprofile) stay UNSUPPORTED, and non-discovery substrates have no
 * discovery adapter.
 */
import {
  resolveSourceRef,
  getDiscoveryAdapterForSubstrate,
  UnsupportedSourceError,
} from '../agent-discovery';
import { EksSourceAdapter } from '../../adapters/agent-source/eks-source-adapter';

const EKS_CLUSTER_ARN = 'arn:aws:eks:us-east-1:123456789012:cluster/my-agent-cluster';
const EKS_NODEGROUP_ARN =
  'arn:aws:eks:us-east-1:123456789012:nodegroup/my-cluster/my-ng/abc12345';
const EKS_FARGATE_ARN =
  'arn:aws:eks:us-east-1:123456789012:fargateprofile/my-cluster/my-fp/abc12345';

describe('resolveSourceRef — EKS cluster ARN (US-IMP-019)', () => {
  it('maps an EKS cluster ARN to { HTTP_ENDPOINT, eks, <arn> }', () => {
    const r = resolveSourceRef(EKS_CLUSTER_ARN);
    expect(r.protocol).toBe('HTTP_ENDPOINT');
    expect(r.substrate).toBe('eks');
    expect(r.target).toBe(EKS_CLUSTER_ARN);
  });

  it.each([EKS_NODEGROUP_ARN, EKS_FARGATE_ARN])(
    'still throws UnsupportedSourceError for a non-cluster EKS ARN %s',
    (arn) => {
      expect(() => resolveSourceRef(arn)).toThrow(UnsupportedSourceError);
      expect(() => resolveSourceRef(arn)).toThrow(/eks not supported in phase 1/);
    },
  );

  it('the non-cluster EKS UnsupportedSourceError still names the eks substrate', () => {
    const err = (() => {
      try {
        resolveSourceRef(EKS_NODEGROUP_ARN);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UnsupportedSourceError);
    expect((err as UnsupportedSourceError).substrate).toBe('eks');
  });
});

describe('getDiscoveryAdapterForSubstrate — eks (US-IMP-019)', () => {
  it("returns an EksSourceAdapter for substrate 'eks'", () => {
    const adapter = getDiscoveryAdapterForSubstrate('eks');
    expect(adapter).toBeInstanceOf(EksSourceAdapter);
  });

  it('threads a credentialProvider into the EKS adapter (cross-account describe)', () => {
    const credentialProvider = { accessKeyId: 'AKIA', secretAccessKey: 'secret' };
    const adapter = getDiscoveryAdapterForSubstrate('eks', { credentialProvider });
    expect(adapter).toBeInstanceOf(EksSourceAdapter);
  });
});
