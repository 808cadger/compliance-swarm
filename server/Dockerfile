FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
# Drop root: node:20-slim ships an unprivileged `node` user. Everything already in /app
# (node_modules from the install above) is chowned first so the app can read it.
RUN chown -R node:node /app
USER node
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
EXPOSE 4210
CMD ["node", "src/index.js"]
