# Bundling image for Python Lambda assets.
#
# The official Lambda base image ships with /lambda-entrypoint.sh as its
# ENTRYPOINT, which expects a handler name — not shell commands.  CDK's
# bundling machinery (and @aws-cdk/aws-lambda-python-alpha's PythonFunction)
# emits `docker run … IMAGE bash -c "pip install …"`, which requires an
# image whose ENTRYPOINT does not intercept the CMD.  Clearing ENTRYPOINT
# makes the image behave like the SAM build images while keeping the exact
# same Python + pip binary that the real Lambda runtime uses.
#
# PythonFunction also uses `rsync` for asset copying, which the Lambda
# base image lacks.  We install it here so the bundling command succeeds.
#
# The SAM build image (public.ecr.aws/sam/build-python3.15) does not exist
# yet as of 2026-11-11; this Dockerfile bridges the gap.
#
# DOCKER_PLATFORM is passed by CDK's DockerBuildOptions.platform and
# forwarded here via TARGETPLATFORM so the base image is always pulled for
# the functions' target architecture (x86_64), even when building on an
# Apple-silicon (aarch64) host.
ARG LAMBDA_BASE_TAG=3.15
ARG TARGETPLATFORM=linux/amd64
FROM --platform=${TARGETPLATFORM} public.ecr.aws/lambda/python:${LAMBDA_BASE_TAG}
# Clear the Lambda bootstrap entrypoint so CDK's `bash -c "…"` CMD runs
# directly as the container process.
ENTRYPOINT []
# Install rsync — required by @aws-cdk/aws-lambda-python-alpha's
# PythonFunction bundling for asset copying.
RUN dnf install -y rsync && dnf clean all
# Ensure pip/python are on PATH (Lambda images put them under /var/lang/bin)
ENV PATH="/var/lang/bin:/usr/local/bin:/usr/bin:/bin"
