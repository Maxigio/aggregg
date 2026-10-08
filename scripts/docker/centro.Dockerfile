FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /opt/amr
# Il postinstall dell'app genera vendor da dipendenze dev. Il centro usa asset
# propri: non modificare i file Git e non installare Electron o browser.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
FROM ghcr.io/restic/restic:0.19.1@sha256:2f0373803493361f9304a57150d464677f69a9dad487afec202105aafb2592f2 AS restic
FROM postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650
WORKDIR /opt/amr
# Binari e librerie provengono da immagini ufficiali fissate per digest.
# L'entrypoint PostgreSQL è disattivato: qui parte soltanto il centro Node.
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /opt/amr/node_modules node_modules/
COPY --from=restic /usr/bin/restic /usr/bin/restic
# Il client restic usa il trust store del sistema, assente nel runtime PostgreSQL.
COPY --from=restic /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --create-home node
COPY package.json package-lock.json ./
COPY backend/ backend/
COPY frontend/ frontend/
COPY pagine/ pagine/
COPY scripts/ scripts/
COPY data/ data/
COPY release.json ./
RUN node -e "const fs=require('node:fs'),crypto=require('node:crypto');const ca=fs.readFileSync('/etc/ssl/certs/ca-certificates.crt','utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);if(!ca?.length)throw new Error('trust_store_tls_assente');for(const pem of ca)new crypto.X509Certificate(pem);"
RUN node -e "const fs=require('node:fs'),crypto=require('node:crypto');const info=p=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});fs.writeFileSync('backup-binaries.json',JSON.stringify({restic:info('/usr/bin/restic'),pgDump:info('/usr/lib/postgresql/18/bin/pg_dump')}));"
# COPY conserva i permessi del contesto, anche se creato con umask privata.
# Il codice resta di root e non scrivibile; la verifica deve poterlo leggere come node.
RUN chmod -R a+rX,a-w /opt/amr && mkdir -p /var/lib/amr && chown node:node /var/lib/amr
ENV NODE_ENV=production HOME=/home/node AMR_NODI_DATA_DIR=/var/lib/amr AMR_NODI_RELEASE_FILE=/opt/amr/release.json
USER node
RUN node -e "require('./backend/nodi/compatibilita-nodo').verificaArtefatto(require('./release.json'),process.cwd())"
EXPOSE 3000
ENTRYPOINT []
CMD ["node", "backend/nodi/centro-run.js"]
