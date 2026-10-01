FROM node:22-bookworm-slim

# Official Debian package, no third-party binary downloads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Uses `npm install` rather than `npm ci`: no package-lock.json ships with this
# build because this environment has no npm registry access to generate one.
# Run `npm install` once with network access and commit the resulting
# package-lock.json, then switch this back to `npm ci --omit=dev` for
# reproducible builds.
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
