# socialcrabs-service/Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Plain Node base image plus Playwright's own Chromium installer — that way the
# browser build always matches the Playwright version SocialCrabs pulls in,
# instead of trusting a tagged base image to line up.
#
#   docker build -t ariana-social-engine .
#   docker run -p 3847:3847 -v ariana_sessions:/data \
#     -e ENGINE_API_KEY=... -e COOKIE_ENCRYPTION_KEY=... ariana-social-engine
#
# Deploy with ONE replica and a volume mounted at /data. Two replicas would
# fight over the same accounts and log each other out.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3847 \
    HOST=0.0.0.0 \
    SESSION_DIR=/data/sessions \
    BROWSER_HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# git: SocialCrabs is a GitHub dependency (it is not on npm).
# ca-certificates + fonts: Chromium needs them to render real pages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so this layer caches across code edits.
COPY package.json ./
RUN npm install --no-audit --no-fund && npm cache clean --force

# SocialCrabs ships TypeScript only — compile it in place, and fail the build
# early if it produced nothing usable.
COPY scripts ./scripts
COPY src ./src
RUN npm run build:socialcrabs

# Chromium + its system libraries, matched to the installed Playwright.
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data/sessions \
 && useradd --create-home --uid 10001 engine \
 && chown -R engine:engine /app /data /ms-playwright

USER engine

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3847)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
