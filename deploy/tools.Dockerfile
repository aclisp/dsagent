# Derived image: the lean dscode-server image + the office/PDF tool layer.
# Build this once on the live env server (cached locally):
#   docker build -f deploy/tools.Dockerfile -t dscode-server .
FROM dscode-server:lean

# Office + PDF toolchain (headless)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils ghostscript qpdf pandoc \
      fonts-noto-cjk fonts-noto-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*