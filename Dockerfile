FROM node:26-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY vendor/node_modules ./node_modules
RUN test -f node_modules/pg/package.json

COPY server.js ./
COPY tools ./tools
COPY public ./public
COPY db ./db

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
