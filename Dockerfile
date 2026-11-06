FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY algorithm/ ./algorithm/
COPY server/ ./server/
COPY data/sample/ ./data/sample/

ENV PLATFORM_DB=/data/platform.db \
    PLATFORM_DATA=/data/platform_data

EXPOSE 8000
VOLUME ["/data"]

CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
