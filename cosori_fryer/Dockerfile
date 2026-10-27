ARG BUILD_FROM=python:3.13-slim-bookworm
FROM ${BUILD_FROM}

# git: pyvesync wird aus einem festen Commit des Dual-Blaze-Entwicklungszweigs
# (lackas/pyvesync, Branch air-fryer-refactor) installiert, weil der
# Standard-Release (3.4.x) die CAF-TF101S noch nicht kennt.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./

ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "/app/main.py"]
