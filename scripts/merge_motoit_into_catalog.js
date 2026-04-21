/**
 * Merge data/motoit_catalog.json in data/models.json (idempotente).
 *
 * Regole:
 *  1. Pulizia pre-merge (rimuove le modifiche di run precedenti):
 *     - Rimuove 'motoit' da ogni brand.sites e da ogni model.sites
 *     - Rimuove brand.motoit e model.slugMotoIt
 *     - Rimuove brand/model creati solo per motoit (sites residui = [])
 *  2. Pulisce motoit_catalog: esclude "marche" fantasma (annunci-<regione>, pagina-*, -altre-*)
 *  3. Per ogni brand Moto.it:
 *     - Prova match case-insensitive con brand esistente.
 *     - Se match: aggiunge brand.motoit = { brandSlug } e 'motoit' a brand.sites
 *     - Se no match: crea nuovo brand solo-Moto.it (es. Cagiva se manca)
 *  4. Per ogni model Moto.it:
 *     - Deriva nome corretto: se nome raw dello scraper è troncato rispetto allo
 *       slug (es. nome="Monster" per slug="monster-1100"), ricostruisce da slug.
 *     - Match su model.nome normalizzato; se trovato: aggiunge slugMotoIt e 'motoit'.
 *     - Altrimenti crea nuovo model solo-Moto.it.
 *  5. Non tocca sites[] esistenti né altri campi (slugSubito, mmmvAutoscout, ecc.)
 */
const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '../data/models.json');
const MOTOIT_PATH  = path.join(__dirname, '../data/motoit_catalog.json');

// Normalizza nome per matching fuzzy: lowercase + solo a-z0-9
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function isValidBrand(b) {
  if (!b.slug || !b.nome) return false;
  if (/^annunci-/i.test(b.slug)) return false;    // regioni
  if (/^pagina-/i.test(b.slug)) return false;     // paginazione
  if (/^-/.test(b.slug)) return false;            // es. -altre-moto-o-tipologie
  return true;
}

// Capitalizza primo carattere di ogni parola; ma mantiene MAIUSCOLO tutto
// quanto è già in un token di 1-3 lettere puramente alfabetico (acronimi tipo GS, CRF, R).
function prettifyFromSlug(slug) {
  return slug.split('-').map(tok => {
    if (!tok) return tok;
    // Acronimi corti solo-lettere → tutto maiuscolo
    if (/^[a-z]{1,3}$/.test(tok)) return tok.toUpperCase();
    // Inizia con lettera → capitalize
    if (/^[a-z]/.test(tok)) return tok[0].toUpperCase() + tok.slice(1);
    // Numeri o misti → tal quale
    return tok;
  }).join(' ');
}

// Sceglie il miglior nome modello tra raw dello scraper e slug.
// Se il raw sembra troncato (norm(raw) è prefisso stretto di norm(slug)),
// usa lo slug per ricostruire il nome.
function bestModelName(rawNome, slug) {
  const raw = (rawNome || '').trim();
  const nRaw = norm(raw);
  const nSlug = norm(slug);
  if (!raw) return prettifyFromSlug(slug);
  if (nRaw === nSlug) return raw;
  if (nSlug.startsWith(nRaw) && nSlug.length > nRaw.length) {
    // Nome troncato → ricostruisci da slug
    return prettifyFromSlug(slug);
  }
  // Se raw è più ricco dello slug (rare, ma possibile) tienilo
  return raw;
}

// ===== CLEANUP pre-merge =====
function cleanupPreviousMerge(moto) {
  const brandsToRemove = [];
  for (const [brandName, brandEntry] of Object.entries(moto)) {
    // Rimuovi motoit dalle sites
    if (Array.isArray(brandEntry.sites)) {
      brandEntry.sites = brandEntry.sites.filter(s => s !== 'motoit');
    }
    // Rimuovi il blocco motoit
    delete brandEntry.motoit;

    // Pulisci i modelli
    if (Array.isArray(brandEntry.models)) {
      const modelsToKeep = [];
      for (const m of brandEntry.models) {
        if (Array.isArray(m.sites)) m.sites = m.sites.filter(s => s !== 'motoit');
        delete m.slugMotoIt;
        // Se il modello era SOLO-motoit (sites vuoto, niente slugSubito né mmmvAutoscout)
        const hasSubito = Boolean(m.slugSubito) || Boolean(m.subitoKey);
        const hasAS     = Boolean(m.mmmvAutoscout);
        const sitesEmpty = !Array.isArray(m.sites) || m.sites.length === 0;
        if (sitesEmpty && !hasSubito && !hasAS) {
          // drop
          continue;
        }
        modelsToKeep.push(m);
      }
      brandEntry.models = modelsToKeep;
    }

    // Se il brand era SOLO-motoit e non ha più sites né dati specifici, drop
    const sitesEmpty = !Array.isArray(brandEntry.sites) || brandEntry.sites.length === 0;
    const hasSubitoBrand    = Boolean(brandEntry.subito) || Boolean(brandEntry.brandKey);
    const hasASBrand        = Boolean(brandEntry.autoscout);
    const hasModels         = Array.isArray(brandEntry.models) && brandEntry.models.length > 0;
    if (sitesEmpty && !hasSubitoBrand && !hasASBrand && !hasModels) {
      brandsToRemove.push(brandName);
    }
  }
  for (const name of brandsToRemove) delete moto[name];
  return brandsToRemove.length;
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const motoit  = JSON.parse(fs.readFileSync(MOTOIT_PATH,  'utf8'));

  const moto = catalog.moto || {};

  // === Pulisci eventuali run precedenti ===
  const removed = cleanupPreviousMerge(moto);
  console.log(`Cleanup: rimossi ${removed} brand solo-motoit residui`);

  const motoBrandsByNorm = new Map();
  for (const [nome, entry] of Object.entries(moto)) {
    motoBrandsByNorm.set(norm(nome), { nome, entry });
  }

  const validBrands = motoit.brands.filter(isValidBrand);
  console.log(`Brand Moto.it validi: ${validBrands.length} (scartati ${motoit.brands.length - validBrands.length} fantasma)`);

  let stats = {
    brandMatched: 0, brandCreated: 0,
    modelMatched: 0, modelCreated: 0,
    modelsTotal: 0,
  };

  for (const mb of validBrands) {
    const key = norm(mb.nome);
    const match = motoBrandsByNorm.get(key);

    let brandEntry;
    let brandName;

    if (match) {
      brandEntry = match.entry;
      brandName = match.nome;
      stats.brandMatched++;
    } else {
      // Crea nuovo brand solo-Moto.it
      brandEntry = { sites: [] };
      brandName = mb.nome;
      moto[brandName] = brandEntry;
      motoBrandsByNorm.set(key, { nome: brandName, entry: brandEntry });
      stats.brandCreated++;
      console.log(`  + Nuovo brand: ${brandName} (slug=${mb.slug})`);
    }

    // Aggiungi metadata motoit al brand
    brandEntry.motoit = { brandSlug: mb.slug };
    if (!Array.isArray(brandEntry.sites)) brandEntry.sites = [];
    if (!brandEntry.sites.includes('motoit')) brandEntry.sites.push('motoit');

    // Modelli
    if (!Array.isArray(brandEntry.models)) brandEntry.models = [];
    const modelsByNorm = new Map();
    for (const m of brandEntry.models) modelsByNorm.set(norm(m.nome), m);

    for (const mm of mb.models) {
      stats.modelsTotal++;
      const niceName = bestModelName(mm.nome, mm.slug);
      const key2 = norm(niceName);
      const existing = modelsByNorm.get(key2);

      if (existing) {
        existing.slugMotoIt = mm.slug;
        if (!Array.isArray(existing.sites)) existing.sites = [];
        if (!existing.sites.includes('motoit')) existing.sites.push('motoit');
        stats.modelMatched++;
      } else {
        // Crea nuovo modello solo-Moto.it
        const newModel = {
          nome: niceName,
          sites: ['motoit'],
          slugMotoIt: mm.slug,
        };
        brandEntry.models.push(newModel);
        modelsByNorm.set(key2, newModel);
        stats.modelCreated++;
      }
    }
  }

  catalog.moto = moto;

  // Ordina i modelli alfabeticamente per ogni brand (migliora UX dropdown)
  for (const b of Object.values(moto)) {
    if (Array.isArray(b.models)) {
      b.models.sort((a, b2) => a.nome.localeCompare(b2.nome, 'it', { sensitivity: 'base' }));
    }
  }

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));

  console.log('\n=== Statistiche merge ===');
  console.log(`Brand: matched=${stats.brandMatched}, created=${stats.brandCreated}`);
  console.log(`Model: matched=${stats.modelMatched}, created=${stats.modelCreated}, totali processati=${stats.modelsTotal}`);

  // Verifica casi notevoli
  console.log('\n=== Verifica casi notevoli ===');
  const verify = (brand, modelNome) => {
    const b = moto[brand];
    if (!b) { console.log(`  ${brand}: BRAND NON TROVATO`); return; }
    console.log(`  ${brand}: motoit.brandSlug=${b.motoit?.brandSlug || '—'}, sites=${JSON.stringify(b.sites)}, modelli=${b.models?.length || 0}`);
    if (modelNome) {
      const m = b.models?.find(x => norm(x.nome) === norm(modelNome));
      if (!m) { console.log(`    ⚠ modello "${modelNome}" NON trovato`); return; }
      console.log(`    ${modelNome}: slugMotoIt=${m.slugMotoIt || '—'}, slugSubito=${m.slugSubito || '—'}, sites=${JSON.stringify(m.sites)}`);
    }
  };
  verify('Cagiva', 'Electra 125');
  verify('BMW', 'R 1200 GS');
  verify('Ducati', 'Monster 1100');
  verify('Ducati', 'Diavel V4');
  verify('Honda', 'Africa Twin CRF 1000L');
  verify('Yamaha', 'MT-07');
  verify('Kawasaki', 'Versys 650');
}

main();
