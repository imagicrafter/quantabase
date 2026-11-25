# The Engine service, built from the repository root.
#
# Built from the root (not engine/) so the running app carries what the
# Database setup screen needs: supabase/migrations and the embed function
# (engine/src/app/db-setup.ts findRepoDir looks three folders above
# engine/dist/app/, which is /app here). The "Deploy to DigitalOcean" button
# (.do/deploy.template.yaml) builds this file.
#
# What ships, under /app:
#   engine/dist, engine/node_modules (production only), engine/package.json
#   engine/public, engine/templates     read at run time
#   supabase/migrations                 applied by the Database screen
#   supabase/functions/embed            deployed by the Database screen
#
# No Python and no pullers: they are server mode, off in this deploy
# (docs/operations.md, "Server mode").

FROM node:22-bookworm-slim AS build
WORKDIR /app/engine
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY engine/tsconfig.json ./
COPY engine/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/engine/dist engine/dist
COPY --from=build --chown=node:node /app/engine/node_modules engine/node_modules
COPY --chown=node:node engine/package.json engine/package.json
COPY --chown=node:node engine/public engine/public
COPY --chown=node:node engine/templates engine/templates
COPY --chown=node:node supabase/migrations supabase/migrations
COPY --chown=node:node supabase/functions/embed supabase/functions/embed
USER node
EXPOSE 8080
CMD ["node", "engine/dist/index.js"]
