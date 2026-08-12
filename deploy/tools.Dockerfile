# Derived image: the lean dscode-server image + the office/PDF tool layer.
# Build this once on the live env server (cached locally):
#   docker build -f deploy/tools.Dockerfile -t dscode-server .
FROM dscode-server:lean

# Common server utilities and the system-level Office/PDF, OCR, image, and font
# toolchain used for document and visual artifact work.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-pip python-is-python3 \
      curl wget jq unzip zip file \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      poppler-utils ghostscript qpdf pandoc imagemagick \
      tesseract-ocr tesseract-ocr-chi-sim \
      fontconfig fonts-noto-cjk fonts-noto-core fonts-liberation \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-urw-base35 \
    && rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/*

# This image is the agent's dedicated tool environment, so artifact libraries
# are intentionally installed system-wide from PyPI at their current versions.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
      defusedxml \
      lxml \
      Pillow \
      reportlab \
      pandas \
      openpyxl \
      pypdf \
      pdfplumber \
      pdf2image \
      pytesseract \
      "markitdown[pptx]" \
      pypdfium2

# JavaScript libraries used by scripts generated in arbitrary workspace paths.
# /node_modules makes globally installed packages discoverable by both CommonJS
# and ESM resolution; NODE_PATH additionally supports CommonJS lookup directly.
RUN npm install --global \
      docx \
      pptxgenjs \
      react \
      react-dom \
      react-icons \
      sharp \
      pdf-lib \
      pdfjs-dist \
    && npm cache clean --force \
    && ln -s /usr/local/lib/node_modules /node_modules

ENV NODE_PATH=/usr/local/lib/node_modules
