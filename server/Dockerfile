FROM node:20-slim
# Sensible default if the runtime .env is ever misconfigured or omitted; docker-compose.yml's
# NODE_ENV: ${NODE_ENV:-production} explicitly falls back to this same value when .env
# doesn't set it, so the two stay in agreement rather than one silently overriding the other.
ENV NODE_ENV=production
# Build context is the repo root, not server/ (see docker-compose.yml's `build:` block) — the
# static Process prototypes below (agents/, shared/, config/, templates/) live there as
# siblings of server/, not under it. WORKDIR mirrors that same repo-root-relative layout
# (/app/server, not /app) so the running app's own directory structure inside the container
# is identical to a plain `git clone` + `cd server && npm start` on a laptop: app.js's static
# mounts (server/src/app.js) walk two directories up from themselves to find agents/ etc, and
# that computation lands in the same place — /app — whether or not this is a container.
WORKDIR /app/server
# No glob on package-lock.json: `package-lock.json*` matched zero files just as happily as
# one, so a missing lockfile produced a green build that had silently re-resolved every
# ^-ranged dependency. Without the glob the COPY fails outright instead, and `npm ci` (rather
# than `npm install`) installs exactly the tree the lockfile pins and refuses to run at all if
# the lockfile has drifted from package.json — so the image can only ever ship the versions
# recorded in git.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
# Drop root: node:20-slim ships an unprivileged `node` user. Everything already in /app/server
# (node_modules from the install above) is chowned first so the app can read it.
RUN chown -R node:node /app/server
# Pre-create the media mount point owned by node:node. A named volume that's empty when
# first mounted is populated from whatever already exists in the image at that path
# (content AND ownership), so this is what makes /data/media writable by the unprivileged
# node user once docker-compose.yml mounts media_data there — without it, Docker creates
# the mount point itself as root:root, and the app process can never write to it.
RUN mkdir -p /data/media && chown -R node:node /data/media
USER node
COPY --chown=node:node server/src ./src
COPY --chown=node:node server/scripts ./scripts
# Repo-root siblings of server/ — see the WORKDIR comment above for why these land at
# /app/agents etc rather than under /app/server, and server/.env.example's
# PROCESS_STATIC_ROOT entry for the (now unused in this image, since this layout is already
# correct) escape hatch that exists for any future layout that isn't.
COPY --chown=node:node agents /app/agents
COPY --chown=node:node shared /app/shared
COPY --chown=node:node config /app/config
COPY --chown=node:node templates /app/templates
EXPOSE 4210
CMD ["node", "src/index.js"]
