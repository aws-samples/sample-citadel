FROM public.ecr.aws/lambda/python:3.12

# Install system dependencies
RUN dnf update -y && \
    dnf install -y \
        wget tar gzip \
        texlive texlive-xetex texlive-collection-fontsrecommended \
        texlive-collection-latexextra \
        liberation-fonts \
        graphviz \
        librsvg2-tools \
    && dnf clean all

# Install pandoc
RUN wget https://github.com/jgm/pandoc/releases/download/3.1.11/pandoc-3.1.11-linux-amd64.tar.gz && \
    tar xvzf pandoc-3.1.11-linux-amd64.tar.gz --strip-components 1 -C /usr/local && \
    rm pandoc-3.1.11-linux-amd64.tar.gz

# Copy Lambda handler
COPY lambda_handler.py ${LAMBDA_TASK_ROOT}/

CMD [ "lambda_handler.handler" ]
