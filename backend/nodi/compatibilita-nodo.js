'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOLLO = 1;
const AMBITO_CODICE = Object.freeze(['backend', 'frontend', 'pagine', 'scripts', 'package.json', 'package-lock.json']);
// Soltanto cataloghi/configurazioni pubbliche della ricerca: mai auth, cache o DB.
const CATALOGHI = Object.freeze([
  'brand-aliases.json', 'models.json', 'model-groups.json', 'menu-gemelli.json',
  'motoit-brands.json', 'motoit-catalogo.json', 'motoit-marche-aggiunte.json',
  'subito-catalogo.json', 'subito-indice.json', 'motoit-slug-correzioni.json',
  'ponte-buchi.json', 'ponte-marche-ospiti.json',
  'ponte-rinominati.json', 'ponte-sottomodelli.json', 'verdetti-marche-subito.json',
  'province.json', 'comune-regione.json', 'comune-sigla.json', 'region-centroids.json', 'filtri-auto.json',
  'as24-modelli.json',
]);
const CARTELLE_CATALOGHI = Object.freeze(['versioni/auto', 'versioni/moto']);
const NECESSARI_CODICE = ['backend/nodi/worker.js', 'backend/nodi/compatibilita-nodo.js', 'package.json', 'package-lock.json'];
function valida(v) {
  if (!v || Array.isArray(v) || v.protocollo !== PROTOCOLLO || typeof v.release !== 'string'
      || typeof v.codice !== 'string' || typeof v.cataloghi !== 'string' || !/^[a-f0-9]{40}$/.test(v.release)
      || !/^[a-f0-9]{64}$/.test(v.codice || '') || !/^[a-f0-9]{64}$/.test(v.cataloghi || '')) {
    throw new Error('compatibilita_nodo_non_valida');
  }
  return { protocollo: PROTOCOLLO, release: v.release, codice: v.codice, cataloghi: v.cataloghi };
}
function compatibile(attesa, ricevuta) {
  try {
    const v = valida(ricevuta);
    return Object.keys(valida(attesa)).every(k => v[k] === attesa[k]);
  } catch { return false; }
}
function percorsoValido(nome) {
  return typeof nome === 'string' && nome.length <= 256
    && nome.split('/').every(p => /^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/.test(p) && p !== 'node_modules');
}
function percorsoCodice(nome) {
  return percorsoValido(nome) && (AMBITO_CODICE.slice(0, 4).some(p => nome.startsWith(p + '/'))
    || ['package.json', 'package-lock.json'].includes(nome));
}
function percorsoCatalogo(nome) {
  return percorsoValido(nome) && (CATALOGHI.includes(nome)
    || (nome.endsWith('.json') && CARTELLE_CATALOGHI.some(p => nome.startsWith(p + '/'))));
}
function validaLista(nomi, ammesso) {
  if (!Array.isArray(nomi) || !nomi.length || nomi.length > 10000
      || nomi.some((n, i) => !ammesso(n) || (i > 0 && nomi[i - 1] >= n))) {
    throw new Error('inventario_release_non_valido');
  }
  return [...nomi];
}
function validaArtefatto(v) {
  const rete = valida(v), inv = v.inventario;
  if (!inv || Array.isArray(inv) || typeof inv !== 'object'
      || Object.keys(inv).some(k => !['codice', 'cataloghi'].includes(k))) {
    throw new Error('inventario_release_non_valido');
  }
  const codice = validaLista(inv.codice, percorsoCodice), cataloghi = validaLista(inv.cataloghi, percorsoCatalogo);
  if (NECESSARI_CODICE.some(n => !codice.includes(n)) || CATALOGHI.some(n => !cataloghi.includes(n))) {
    throw new Error('inventario_release_incompleto');
  }
  return { ...rete, inventario: { codice, cataloghi } };
}
// Non seguire link neppure nei genitori: un inventario non può leggere fuori
// dall'artefatto o trasformare un catalogo pubblico in un file personale.
function leggiFile(radice, nome) {
  const radiceStat = fs.lstatSync(radice);
  if (!radiceStat.isDirectory() || radiceStat.isSymbolicLink()) throw new Error('file_release_non_valido');
  let file = radice;
  const parti = nome.split('/');
  for (let i = 0; i < parti.length; i++) {
    file = path.join(file, parti[i]);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (i === parti.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('file_release_non_valido');
    }
  }
  return fs.readFileSync(file, { flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
}
// Elencare anche file senza estensione e residui: require('./x') può caricare
// un file aggiunto prima di x.js. Qui si leggono solo nomi e metadati.
function listaCodice(radice) {
  try {
    const stat = fs.lstatSync(radice), nomi = [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    function visita(relativo) {
      const file = path.join(radice, relativo), voce = fs.lstatSync(file);
      if (voce.isSymbolicLink()) throw new Error();
      if (!percorsoValido(relativo)) throw new Error();
      if (voce.isDirectory()) {
        for (const nome of fs.readdirSync(file)) visita(relativo + '/' + nome);
      } else {
        if (!voce.isFile() || !percorsoCodice(relativo)) throw new Error();
        nomi.push(relativo);
      }
    }
    for (const nome of AMBITO_CODICE) visita(nome);
    return validaLista(nomi.sort(), percorsoCodice);
  } catch { throw new Error('codice_non_leggibile'); }
}
function listaCataloghi(directory) {
  const radiceStat = fs.lstatSync(directory);
  if (!radiceStat.isDirectory() || radiceStat.isSymbolicLink()) throw new Error('cataloghi_non_leggibili');
  const nomi = [...CATALOGHI];
  function visita(relativo) {
    let stat;
    try { stat = fs.lstatSync(path.join(directory, relativo)); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('cataloghi_non_leggibili');
    for (const voce of fs.readdirSync(path.join(directory, relativo), { withFileTypes: true })) {
      const nome = relativo + '/' + voce.name;
      if (voce.isSymbolicLink()) throw new Error('cataloghi_non_leggibili');
      if (voce.isDirectory()) {
        if (!percorsoValido(nome)) throw new Error('cataloghi_non_leggibili');
        visita(nome);
      } else if (voce.name.endsWith('.json')) {
        if (!voce.isFile() || !percorsoCatalogo(nome)) throw new Error('cataloghi_non_leggibili');
        nomi.push(nome);
      }
    }
  }
  try {
    // Verificare anche versioni/ prima della visita, senza seguire link.
    const stat = fs.lstatSync(path.join(directory, 'versioni'));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('cataloghi_non_leggibili');
    for (const cartella of CARTELLE_CATALOGHI) visita(cartella);
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('cataloghi_non_leggibili'); }
  return nomi.sort();
}
function hashFiles(nomi, leggi) {
  const hash = crypto.createHash('sha256');
  for (const nome of nomi) {
    const contenuto = leggi(nome);
    if (!Buffer.isBuffer(contenuto)) throw new Error('file_release_non_valido');
    hash.update(JSON.stringify([nome, contenuto.length])); hash.update(contenuto);
  }
  return hash.digest('hex');
}
function hashCodice(radice, nomi, leggi = nome => leggiFile(radice, nome)) {
  try { return hashFiles(validaLista(nomi, percorsoCodice), leggi); }
  catch { throw new Error('codice_non_leggibile'); }
}
function hashCataloghi(directory, leggi, nomi = listaCataloghi(directory)) {
  try { return hashFiles(validaLista(nomi, percorsoCatalogo), nome => leggi ? leggi(path.join(directory, nome)) : leggiFile(directory, nome)); }
  catch { throw new Error('cataloghi_non_leggibili'); }
}
function verificaArtefatto(v, radice) {
  const artefatto = validaArtefatto(v);
  const codice = listaCodice(radice);
  if (JSON.stringify(codice) !== JSON.stringify(artefatto.inventario.codice)
      || hashCodice(radice, codice) !== artefatto.codice) throw new Error('codice_release_incompatibile');
  const directory = path.join(radice, 'data'), nomi = listaCataloghi(directory);
  if (JSON.stringify(nomi) !== JSON.stringify(artefatto.inventario.cataloghi)
      || hashCataloghi(directory, undefined, nomi) !== artefatto.cataloghi) throw new Error('cataloghi_release_incompatibili');
  // Verifica drift dei file distribuiti, non attesta un nodo malevolo. node_modules
  // non è inventariato: package-lock.json è verificato, l'installazione resta fidata.
  return valida(artefatto);
}
module.exports = { PROTOCOLLO, AMBITO_CODICE, CATALOGHI, CARTELLE_CATALOGHI, valida, compatibile,
  percorsoCodice, percorsoCatalogo, validaArtefatto, listaCodice, listaCataloghi, hashCodice, hashCataloghi, verificaArtefatto };
