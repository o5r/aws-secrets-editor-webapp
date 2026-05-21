FROM node:25-alpine AS build

WORKDIR /app

COPY package.json tsconfig.json .npmrc ./
COPY src ./src
COPY public ./public

RUN npm install --production=false && npm run build

FROM node:25-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json .npmrc ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000

CMD ["node", "dist/server.js"]
