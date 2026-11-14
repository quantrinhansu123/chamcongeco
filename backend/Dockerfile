FROM ghcr.io/astral-sh/uv:0.13.8 AS uv
FROM python:3.12-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=0 \
    PATH="/app/.venv/bin:$PATH" FACE_MODEL_DIR=/models FACE_DATA_DIR=/data \
    APP_ENV=production PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app \
    && mkdir /app /data /models && chown app:app /app /data /models
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
COPY backend/scripts ./scripts
RUN uv sync --frozen --no-dev && chown -R app:app /app
USER app
ARG FACE_DOWNLOAD_MODELS=0
RUN if [ "$FACE_DOWNLOAD_MODELS" = "1" ]; then APP_ENV=development python scripts/download_models.py; fi
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os; from urllib.request import urlopen; urlopen('http://127.0.0.1:' + os.getenv('PORT', '8000') + '/readyz', timeout=4).read()"
CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1 --no-access-log"]
