FROM node:22-alpine

RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tickers.json ./tickers.json
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV ACTUAL_DATA_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["/docker-entrypoint.sh"]
