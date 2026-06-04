FROM python:3.13-slim

WORKDIR /app

# 외부에서 마운트하거나 COPY로 넣을 수 있음
ENV TILES_DIR=/app/output/3dtiles \
    TILES_PATH=/tiles             \
    HOST=0.0.0.0                  \
    PORT=8080

COPY server.py .

# 타일 데이터를 이미지에 포함할 경우 (옵션)
# COPY output/3dtiles ./output/3dtiles

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=3s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

CMD ["python", "server.py"]
