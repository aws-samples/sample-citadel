"""Cross-region Bedrock inference-profile prefix resolution.

Pure, dependency-free helper shared across arbiter Lambda functions via the
bundled layer. No I/O, no AWS clients, no environment reads.
"""
from __future__ import annotations


def cross_region_prefix(region: str) -> str:
    """Return the cross-region inference-profile prefix for an AWS region."""
    if region.startswith('us-'):
        return 'us'
    if region.startswith('eu-'):
        return 'eu'
    if region == 'ap-southeast-2':
        return 'au'
    if region.startswith('ap-'):
        return 'apac'
    if region.startswith('me-'):
        return 'me'
    if region.startswith('ca-'):
        return 'ca'
    if region.startswith('sa-'):
        return 'sa'
    if region.startswith('af-'):
        return 'af'
    return 'us'
