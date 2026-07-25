FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node contract ./contract
COPY --chown=node:node generated ./generated
COPY --chown=node:node src ./src

USER node

ENTRYPOINT ["node", "src/index.js"]
