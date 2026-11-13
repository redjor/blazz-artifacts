FROM node:24.22.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build:web

FROM node:24.22.1-alpine
LABEL org.opencontainers.image.title="Blazz Artifacts" \
      org.opencontainers.image.description="Self-hosted hub to publish and share HTML, Markdown, PDF, JSON and ZIP artifacts" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 3000 3001
CMD ["node", "src/main.ts"]
