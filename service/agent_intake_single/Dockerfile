# Official Python base image: ghcr.io/astral-sh/uv has no python3.15 tag yet
# (confirmed via `docker manifest inspect ghcr.io/astral-sh/uv:latest` —
# the image only ships python3.9 through python3.13 variants), so this
# Dockerfile uses the official `python:3.15-slim-bookworm` base and copies
# the `uv`/`uvx` binaries in from astral-sh's dedicated uv-only image
# instead. uv version resolved from `curl -s
# https://api.github.com/repos/astral-sh/uv/releases/latest` (tag_name
# "0.13.9") on 2026-11-22, and cross-checked that
# `ghcr.io/astral-sh/uv:0.13.9` and `ghcr.io/astral-sh/uv:latest` resolve to
# the identical linux/amd64 manifest digest via `docker manifest inspect`,
# so pinning the tag below is equivalent to pinning the digest at the time
# this was written.
FROM python:3.15-slim-bookworm@sha256:96599df822d0e1c6bb700014a05c7f3c8cabc6e0f7ff3c4f9f69cee033b4b5d9
COPY --from=ghcr.io/astral-sh/uv:0.13.9@sha256:49fe3c925d4b7a84ba2ef19883307bba2bbcf929a22040afb46f2dd092d13aeb /uv /uvx /bin/

WORKDIR /app

# All environment variables in one layer
ENV UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=0 \
    UV_NO_PROGRESS=1 \
    PYTHONUNBUFFERED=1 \
    DOCKER_CONTAINER=1 



COPY requirements.txt requirements.txt
# Install all dependencies in a single layer to avoid QEMU emulation hangs
RUN uv pip install -r requirements.txt "aws-opentelemetry-distro>=0.19.0"


# Signal that this is running in Docker for host binding logic
ENV DOCKER_CONTAINER=1

# Create non-root user
RUN useradd -m -u 1000 bedrock_agentcore


USER bedrock_agentcore

EXPOSE 9000
EXPOSE 8000
EXPOSE 8080

# Copy entire project (respecting .dockerignore)
COPY . .

# Run the agent entrypoint directly
CMD ["opentelemetry-instrument", "python", "agent.py"]
