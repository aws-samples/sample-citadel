# Placeholder Python Layer Asset

This directory is an inert placeholder used by `CITADEL_SKIP_BUNDLING=1`
(test/CI environments only) in place of the real Docker-bundled Python layer.

When `CITADEL_SKIP_BUNDLING=1` and `ENVIRONMENT=test`, the
`pythonAssetCode()` helper in `runtime-constants.ts` returns
`Code.fromAsset()` pointing here instead of running the real Docker-based
bundling command. This lets `cdk synth` complete without a Docker daemon.

The real bundling (pip install, architecture verification, layer packaging)
runs when the flag is unset. See `runtime-constants.ts` for the full guard.
