FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY travel-agent-pi-package/package.json travel-agent-pi-package/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run web:build && npm run mcp:build

FROM node:24.12.0-bookworm-slim
ENV NODE_ENV=production TRAVEL_AGENT_BIND_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/runtime-data && chown node:node /app/runtime-data
USER node
EXPOSE 8797 8798
CMD ["npm", "run", "api"]
