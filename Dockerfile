# wyze-cams dashboard image: serves the browser camera dashboard (cam-frontend)
# running against this repo's wyze-cams library source (src/).
FROM node:20-slim

WORKDIR /app

# Install the library dependencies (axios, werift, ffmpeg-static, aws-sdk, ...).
# ffmpeg-static downloads a static ffmpeg binary during install — no system
# ffmpeg package required.
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Library source.
COPY src ./src

# Frontend server + static dashboard, plus its own dependency (dotenv).
COPY cam-frontend ./cam-frontend
RUN cd cam-frontend && npm install --omit=dev

# Persist Wyze login tokens (wyze-<uuid>.json) in a mountable volume so the
# container doesn't re-authenticate on every restart.
ENV PERSIST_PATH=/data
RUN mkdir -p /data
VOLUME ["/data"]

WORKDIR /app/cam-frontend
EXPOSE 3030
CMD ["node", "server.js"]
