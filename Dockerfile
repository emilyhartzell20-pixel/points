# LeadG2 Service Points. No npm dependencies: Node's built-in http, sqlite and test runner only.
FROM node:22.14-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/leadg2.db
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY data/sample ./data/sample
COPY data/menus ./data/menus
# The database lives on a persistent volume mounted at /data.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
