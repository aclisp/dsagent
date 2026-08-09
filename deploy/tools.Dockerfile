# Derived image: the lean dscode-server image + the office/PDF tool layer.
# Build this once on the live env server (cached locally):
#   docker build -f deploy/tools.Dockerfile -t dscode-server .
FROM dscode-server:lean

# Common server utilities, Office + PDF toolchain (headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 curl wget jq unzip zip file \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      poppler-utils ghostscript qpdf pandoc \
      fonts-noto-cjk fonts-noto-core fonts-liberation \
    && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*
