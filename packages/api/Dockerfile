# Build the Ai-Guard API. Multi-stage: build the whole workspace, then ship a
# minimal runtime with only fastify + pg (everything else is bundled in).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ai-guard/policy-engine build \
 && pnpm --filter @ai-guard/api build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Third-party deps are external to the bundle (dynamic requires); install them.
RUN printf '{"name":"ai-guard-api-runtime","private":true,"type":"module","dependencies":{"@fastify/rate-limit":"10.3.0","fastify":"5.2.0","ioredis":"5.4.2","pg":"8.13.1","prom-client":"15.1.3","zod":"3.23.8","yaml":"2.6.1","langfuse":"3.29.0"}}' > package.json \
 && npm install --omit=dev --no-package-lock --no-audit --no-fund
COPY --from=build /app/packages/api/dist ./dist
COPY ai-guard.yaml ./ai-guard.yaml
# Run as the unprivileged `node` user shipped in the base image, not root.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
