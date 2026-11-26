/**
 * TDD (Phase 2, agent-import): toInvokeCredentials maps the VendedCredentials
 * returned by vendImportCredentials onto the static AWS credential identity an
 * AWS-native adapter hands to its protocol SDK client. Pure + side-effect free;
 * never logs. Returns undefined when no assume happened (no usable creds), so a
 * cross-account caller can FAIL rather than silently use the handler identity.
 */
import { toInvokeCredentials } from '../invoke-support';
import type { VendedCredentials } from '../base';

describe('toInvokeCredentials', () => {
  it('maps assumed vended credentials to a static AWS credential identity', () => {
    const vended: VendedCredentials = {
      roleArn: 'arn:aws:iam::222233334444:role/CustomerInvokeRole',
      accessKeyId: 'ASIA-ASSUMED',
      secretAccessKey: 'assumed-secret',
      sessionToken: 'assumed-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };

    expect(toInvokeCredentials(vended)).toEqual({
      accessKeyId: 'ASIA-ASSUMED',
      secretAccessKey: 'assumed-secret',
      sessionToken: 'assumed-token',
      expiration: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  it('omits sessionToken and expiration when they are absent', () => {
    const vended: VendedCredentials = { accessKeyId: 'AK', secretAccessKey: 'SK' };
    expect(toInvokeCredentials(vended)).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' });
  });

  it('returns undefined when no usable access key is present (no assume happened)', () => {
    // The no-roleArn minimal descriptor and any partial result must NOT yield a
    // credential identity — the caller treats "no creds" as a failure on a
    // cross-account target rather than falling back to the handler identity.
    expect(toInvokeCredentials({})).toBeUndefined();
    expect(toInvokeCredentials({ roleArn: 'arn:aws:iam::222233334444:role/X' })).toBeUndefined();
    expect(toInvokeCredentials({ accessKeyId: 'AK' })).toBeUndefined();
  });
});
