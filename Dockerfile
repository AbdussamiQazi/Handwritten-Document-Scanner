FROM python:3.12-slim

WORKDIR /app

# --- Install System Dependencies ---
# Dependencies for Pillow (libjpeg, zlib, freetype) and general build tools (gcc, g++, curl)
# Added libpq-dev (PostgreSQL client) as a common dependency in case you add a database later,
# and libxrender1/libglib2.0-0 for PyMuPDF rendering stability.
RUN apt-get update && apt-get install -y \
    gcc g++ curl \
    libjpeg-dev \
    zlib1g-dev \
    libfreetype6-dev \
    libxrender1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*




COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["gunicorn", "api:app", "--bind", "0.0.0.0:8000", "--workers", "4", "--worker-class", "uvicorn.workers.UvicornWorker"]