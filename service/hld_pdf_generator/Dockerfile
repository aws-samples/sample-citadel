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
RUN wget -q "https://github.com/jgm/pandoc/releases/download/3.1.11/pandoc-3.1.11-linux-${TARGETARCH}.tar.gz" && \
    tar xzf "pandoc-3.1.11-linux-${TARGETARCH}.tar.gz" --strip-components 1 -C /usr/local && \
    rm "pandoc-3.1.11-linux-${TARGETARCH}.tar.gz"

# Copy Lambda handler
COPY lambda_handler.py ${LAMBDA_TASK_ROOT}/

CMD [ "lambda_handler.handler" ]
