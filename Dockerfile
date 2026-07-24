# Multi-stage build for the DentalCare backend.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrate.ts ./src/db/migrate.ts
COPY --from=builder /app/src/db/seed.ts ./src/db/seed.ts
COPY --from=builder /app/src/db/reset.ts ./src/db/reset.ts
COPY --from=builder /app/src/db/pool.ts ./src/db/pool.ts
COPY --from=builder /app/src/config.ts ./src/config.ts
COPY tsconfig.json ./
EXPOSE 4000
CMD ["node", "dist/server.js"]
