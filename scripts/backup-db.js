#!/usr/bin/env node
/**
 * Backup giornaliero del DB `automotoradar` → /Volumes/MAIN/backups (pg_dump -Fc).
 * Eseguito da launchd `com.automotoradar.backup` VIA NODE: `/bin/bash` non ha il
 * permesso TCC su /Volumes/MAIN sotto launchd, ma `/usr/local/bin/node` sì (stesso
 * binario del server). Fail-loud: ogni errore esce non-zero e logga.
 *
 * Verifica manuale: node scripts/backup-db.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = '/Volumes/MAIN/BananaChePrezzi-main';
const BACKUP_DIR  = '/Volumes/MAIN/backups';
const PGBIN       = '/Volumes/SERVER/PosgtreSQL/bin';
const RETENTION_DAYS = 14;
const MIN_SIZE    = 10000;   // byte: sotto = dump sospetto

const log  = (...a) => console.log(new Date().toISOString(), '[backup]', ...a);
const fail = (m) => { console.error(new Date().toISOString(), '[backup] ERRORE:', m); process.exit(1); };

// ── Mount-guard: /Volumes/MAIN montato (disco diverso da PGDATA su /Volumes/SERVER) ──
if (!fs.existsSync('/Volumes/MAIN') || !fs.existsSync(ROOT)) fail('/Volumes/MAIN non montato → backup saltato');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ── Credenziali dal .env (gitignored): nessun segreto duplicato nello script ──
let url;
try {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m = env.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
  url = m && m[1].trim().replace(/^["']|["']$/g, '');
} catch (e) { fail('.env illeggibile: ' + e.message); }
if (!url) fail('DATABASE_URL mancante nel .env');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const out = path.join(BACKUP_DIR, `automotoradar_${stamp}.dump`);

// ── Dump (formato custom -Fc: compresso + pg_restore selettivo) ──
log('inizio dump →', out);
try {
  execFileSync(path.join(PGBIN, 'pg_dump'), ['-Fc', '-d', url, '-f', out], { stdio: ['ignore', 'inherit', 'inherit'] });
} catch (e) { try { fs.unlinkSync(out); } catch (_) {} fail('pg_dump fallito: ' + e.message); }

// ── Validazione: dimensione minima + archivio elencabile ──
const size = fs.statSync(out).size;
if (size < MIN_SIZE) { fs.unlinkSync(out); fail(`dump troppo piccolo (${size} B)`); }
try { execFileSync(path.join(PGBIN, 'pg_restore'), ['-l', out], { stdio: 'ignore' }); }
catch (e) { fs.unlinkSync(out); fail('archivio non valido (pg_restore -l)'); }

fs.writeFileSync(path.join(BACKUP_DIR, 'LAST_OK'), `${new Date().toISOString()} ${out} (${size} B)\n`);
log(`OK dump valido (${size} B)`);

// ── Retention: elimina i dump più vecchi di RETENTION_DAYS ──
const cutoff = Date.now() - RETENTION_DAYS * 86400000;
let removed = 0;
for (const f of fs.readdirSync(BACKUP_DIR)) {
  if (!/^automotoradar_.*\.dump$/.test(f)) continue;
  const p = path.join(BACKUP_DIR, f);
  if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
}
log(`retention applicata (rimossi ${removed} dump >${RETENTION_DAYS}gg)`);
