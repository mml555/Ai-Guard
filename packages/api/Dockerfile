# Build the Ai-Guard API. Multi-stage: build the whole workspace, then ship a
# runtime that bundles our workspace code and installs only the third-party deps
# the bundle leaves external (fastify, pg, jose, …).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ai-guard/policy-engine build \
 && pnpm --filter @ai-guard/api build
# Derive the runtime dependency manifest from packages/api/package.json so the
# runtime install can never drift from what the bundle externalizes. Pins the
# exact installed (locked) versions. See scripts/gen-runtime-pkg.mjs.
RUN node packages/api/scripts/gen-runtime-pkg.mjs

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Install exactly the externalized third-party deps (generated, not hand-listed).
COPY --from=build /app/packages/api/dist/runtime-package.json ./package.json
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund
COPY --from=build /app/packages/api/dist ./dist
COPY ai-guard.yaml ./ai-guard.yaml
# Run as the unprivileged `node` user shipped in the base image, not root.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
