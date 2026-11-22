# syntax=docker/dockerfile:1
# --------------------------------------------------------------------------
# PDF generator Lambda — produces PDFs from markdown via pandoc + XeLaTeX.
#
# Multi-arch: TARGETARCH is injected by BuildKit (amd64 or arm64).
# Pandoc's GitHub releases use the scheme `linux-{amd64,arm64}`.
# texlive and liberation-fonts are arch-independent; dnf resolves the
# correct native packages automatically.
# --------------------------------------------------------------------------
ARG TARGETARCH
FROM public.ecr.aws/lambda/python:3.15

# Install system dependencies (arch-independent package names; dnf handles
# the underlying RPM arch automatically).
RUN dnf update -y && \
    dnf install -y \
        wget tar gzip \
        texlive texlive-xetex texlive-collection-fontsrecommended \
        texlive-collection-latexextra \
        liberation-fonts \
        graphviz \
        librsvg2-tools \
    && dnf clean all

# Install pandoc — use TARGETARCH to select the correct binary.
# Re-declare ARG after FROM so it's available in this build stage.
ARG TARGETARCH
# Pandoc 3.1.11 does not publish a release-wide checksums file, so these
# SHA256 digests were computed locally from the tarballs fetched directly
# from the GitHub release asset URLs below (verified 2026-11-22):
#   https://github.com/jgm/pandoc/releases/download/3.1.11/pandoc-3.1.11-linux-amd64.tar.gz
#   https://github.com/jgm/pandoc/releases/download/3.1.11/pandoc-3.1.11-linux-arm64.tar.gz
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) PANDOC_SHA256="c573fc25bc0880879bfff9a929a2a9c6834a6c5e4d7d1669fb23eddeaef37937" ;; \
        arm64) PANDOC_SHA256="d7737918fa30377783df0c7f6b7e6bdbbea9607c9c2f0b5ee6e473647a3194a5" ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q "https://github.com/jgm/pandoc/releases/download/3.1.11/pandoc-3.1.11-linux-${TARGETARCH}.tar.gz"; \
    echo "${PANDOC_SHA256}  pandoc-3.1.11-linux-${TARGETARCH}.tar.gz" | sha256sum -c -; \
    tar xzf "pandoc-3.1.11-linux-${TARGETARCH}.tar.gz" --strip-components 1 -C /usr/local; \
    rm "pandoc-3.1.11-linux-${TARGETARCH}.tar.gz"

# Copy Lambda handler
COPY lambda_handler.py ${LAMBDA_TASK_ROOT}/

CMD [ "lambda_handler.handler" ]
