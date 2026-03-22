FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
RUN npm ci --workspace apps/backend --include-workspace-root=false

COPY apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY apps/backend/src apps/backend/src
RUN npm run build --workspace apps/backend

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
RUN npm ci --omit=dev --workspace apps/backend --include-workspace-root=false

COPY --from=build /app/apps/backend/dist apps/backend/dist
COPY apps/backend/data apps/backend/data

EXPOSE 4000 4001
CMD ["node", "apps/backend/dist/index.js"]

