# syntax=docker/dockerfile:1.7
# Optional speech-to-text layer for RenderWeld (issue #300, D-114,
# docs/CAPTIONS.md#speech-to-text). Not part of the release image: Python,
# faster-whisper and a model add several hundred MB. Build it on top of the
# image you run, from the repository root:
#
#   docker build -t reelforge-studio:release .
#   docker build -f deployment/stt/Dockerfile \
#     --build-arg BASE=reelforge-studio:release --build-arg WHISPER_MODEL=small \
#     -t reelforge-studio:release-stt .
#
# The model is downloaded here, at build time, into /opt/reelforge/whisper-models;
# at run time nothing is downloaded (Hugging Face offline mode is forced by the
# server and by reelforge-whisper). Pick the model with WHISPER_MODEL: tiny,
# base, small (default), medium, large-v3, distil-large-v3, or a .en variant.
ARG BASE=reelforge-studio:release
FROM ${BASE}
ARG WHISPER_MODEL=small
USER root
# Python for faster-whisper. The versions are pinned: PyAV 19 removed an argument
# faster-whisper 1.2.1 passes to av.open, so av stays on 18.0.0 (checked 2026-11-23).
# Behind a TLS-intercepting proxy, pass its CA bundle as the same optional build secret
# as the main Dockerfile (never stored in a layer): --secret id=extra_ca,src=/path/to/ca.crt
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca SSL_CERT_FILE=/run/secrets/extra_ca REQUESTS_CA_BUNDLE=/run/secrets/extra_ca; fi; \
    apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/reelforge/stt \
 && /opt/reelforge/stt/bin/pip install --no-cache-dir faster-whisper==1.2.1 av==18.0.0 \
 && HF_HUB_DISABLE_XET=1 /opt/reelforge/stt/bin/python -I -c \
      "import sys; from faster_whisper import download_model; print(download_model(sys.argv[1], cache_dir='/opt/reelforge/whisper-models'))" "${WHISPER_MODEL}" \
 && rm -rf /root/.cache /tmp/*
COPY deployment/stt/reelforge-whisper /opt/reelforge/stt/bin/reelforge-whisper
RUN sed -i '1s|.*|#!/opt/reelforge/stt/bin/python3 -I|' /opt/reelforge/stt/bin/reelforge-whisper \
 && chmod 0755 /opt/reelforge/stt/bin/reelforge-whisper \
 && ln -s /opt/reelforge/stt/bin/reelforge-whisper /usr/local/bin/reelforge-whisper \
 && chmod -R a+rX /opt/reelforge
ENV RENDERWELD_STT_MODEL=${WHISPER_MODEL} \
    RENDERWELD_STT_MODEL_DIR=/opt/reelforge/whisper-models
USER 10001:10001
