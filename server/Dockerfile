FROM node:20-slim
WORKDIR /app
# No glob on package-lock.json: `package-lock.json*` matched zero files just as happily as
# one, so a missing lockfile produced a green build that had silently re-resolved every
# ^-ranged dependency. Without the glob the COPY fails outright instead, and `npm ci` (rather
# than `npm install`) installs exactly the tree the lockfile pins and refuses to run at all if
# the lockfile has drifted from package.json — so the image can only ever ship the versions
# recorded in git.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Drop root: node:20-slim ships an unprivileged `node` user. Everything already in /app
# (node_modules from the install above) is chowned first so the app can read it.
RUN chown -R node:node /app
USER node
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
EXPOSE 4210
CMD ["node", "src/index.js"]
