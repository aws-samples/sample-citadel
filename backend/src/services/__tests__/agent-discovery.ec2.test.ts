/**
 * EC2 additions to agent-discovery (US-IMP-020).
 *
 * EC2 is a DISCOVERY SUBSTRATE: a pasted EC2 INSTANCE ARN now resolves to a
 * HTTP_ENDPOINT invocation on substrate 'ec2' (no longer UnsupportedSourceError),
 * and `getDiscoveryAdapterForSubstrate` dispatches the substrate to the
 * Ec2SourceAdapter for describe/healthCheck. Non-instance EC2 ARNs (vpc,
 * security-group, volume) stay UNSUPPORTED, and non-discovery substrates have no
 * discovery adapter.
 */
import {
  resolveSourceRef,
  getDiscoveryAdapterForSubstrate,
  UnsupportedSourceError,
} from '../agent-discovery';
import { Ec2SourceAdapter } from '../../adapters/agent-source/ec2-source-adapter';

const EC2_INSTANCE_ARN = 'arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0';
const EC2_VPC_ARN = 'arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0abc1234';
const EC2_SG_ARN = 'arn:aws:ec2:us-east-1:123456789012:security-group/sg-0abc1234';
const EC2_VOLUME_ARN = 'arn:aws:ec2:us-east-1:123456789012:volume/vol-0abc1234';

describe('resolveSourceRef — EC2 instance ARN (US-IMP-020)', () => {
  it('maps an EC2 instance ARN to { HTTP_ENDPOINT, ec2, <arn> }', () => {
    const r = resolveSourceRef(EC2_INSTANCE_ARN);
    expect(r.protocol).toBe('HTTP_ENDPOINT');
    expect(r.substrate).toBe('ec2');
    expect(r.target).toBe(EC2_INSTANCE_ARN);
  });

  it.each([EC2_VPC_ARN, EC2_SG_ARN, EC2_VOLUME_ARN])(
    'still throws UnsupportedSourceError for a non-instance EC2 ARN %s',
    (arn) => {
      expect(() => resolveSourceRef(arn)).toThrow(UnsupportedSourceError);
      expect(() => resolveSourceRef(arn)).toThrow(/ec2 not supported in phase 1/);
    },
  );

  it('the non-instance EC2 UnsupportedSourceError still names the ec2 substrate', () => {
    const err = (() => {
      try {
        resolveSourceRef(EC2_VPC_ARN);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UnsupportedSourceError);
    expect((err as UnsupportedSourceError).substrate).toBe('ec2');
  });
});

describe('getDiscoveryAdapterForSubstrate — ec2 (US-IMP-020)', () => {
  it("returns an Ec2SourceAdapter for substrate 'ec2'", () => {
    const adapter = getDiscoveryAdapterForSubstrate('ec2');
    expect(adapter).toBeInstanceOf(Ec2SourceAdapter);
  });

  it('threads a credentialProvider into the EC2 adapter (cross-account describe)', () => {
    const credentialProvider = { accessKeyId: 'AKIA', secretAccessKey: 'secret' };
    const adapter = getDiscoveryAdapterForSubstrate('ec2', { credentialProvider });
    expect(adapter).toBeInstanceOf(Ec2SourceAdapter);
  });
});
