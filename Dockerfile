FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY prompts ./prompts
COPY tests ./tests
ENV PORT=3000
EXPOSE 3000
# البيانات خارج الإيمج (volumes في compose)
VOLUME ["/app/backups", "/app/tenants"]
CMD ["node", "src/server.js"]
