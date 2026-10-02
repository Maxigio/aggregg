FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /opt/amr
# Il postinstall dell'app genera vendor da dipendenze dev. Il centro usa asset
# propri: non modificare i file Git e non installare Electron o browser.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY backend/ backend/
COPY frontend/ frontend/
COPY pagine/ pagine/
COPY scripts/ scripts/
COPY data/ data/
COPY release.json ./
RUN node -e "require('./backend/nodi/compatibilita-nodo').verificaArtefatto(require('./release.json'),process.cwd())" \
    && chmod -R a-w /opt/amr && mkdir -p /var/lib/amr && chown node:node /var/lib/amr
ENV NODE_ENV=production AMR_NODI_DATA_DIR=/var/lib/amr AMR_NODI_RELEASE_FILE=/opt/amr/release.json
USER node
EXPOSE 3000
CMD ["node", "backend/nodi/centro-run.js"]
