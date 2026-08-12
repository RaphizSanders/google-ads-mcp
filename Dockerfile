# Google Ads MCP — imagem para Railway (ou qualquer host)
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Produção: só runtime
FROM ${NODE_IMAGE}

WORKDIR /app

RUN addgroup -g 10001 googleads && adduser -D -u 10001 -G googleads googleads

COPY --chown=10001:10001 package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder --chown=10001:10001 /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3333

EXPOSE 3333

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3333}/health" >/dev/null || exit 1

CMD ["node", "dist/index.js"]
