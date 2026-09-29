const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const logger = require('./logger').install();
const express = require('express');
const auth = require('./auth');
const utentiDb = require('./utenti-db');
const { catalogResolver, lookupBrand, lookupModelGroup } = require('./catalogo-ricerca');
const { parseSearchParams } = require('./ricerca-parametri');
const { runSearch, cacheable, runSource, runSubito, as24LivelloAllargamento } = require('./ricerca-coordinatore');

const app = express();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
const PORT = process.env.PORT || 3000;

const { gateAuth, postLogin, loginAttempts, percorsoGate, soloOwner, SOLO_OWNER, AUTH_FREE,
  tettoGiornaliero, TETTO_GIORNALIERO, clientIp, chiaveLimite } = require('./accesso-route').mount(app, { logger });

require('./report-route').mount(app, { chiaveLimite });

require('./frontend-route').mount(app);

require('./menu-ricerca-route').mount(app);

require('./veicolo-dati-route').mount(app);

require('./dettaglio-route').mount(app, { chiaveLimite });

const { tailscalePublicUrl } = require('./public-url-route').mount(app);

const limiteRicerche = require('./limite-richieste').crea({ max: 60, cosa: 'ricerche' });
app.get('/api/search', async (req, res) => {
  const gRic = limiteRicerche.consuma(chiaveLimite(req));
  if (!gRic.ok) return res.status(429).json({ error: limiteRicerche.messaggio(gRic), riprovaFra: gRic.attesa, restanti: 0 });
  const parsed = parseSearchParams(req.query);
  if (parsed.errors) {
    return res.status(400).json({ error: parsed.errors.join(', ') });
  }
  parsed.params._cacheScope = req.authId || 'locale';

  let passa = false;
  tettoGiornaliero(req, res, () => { passa = true; });
  if (!passa) return;
  try {
    const out = await runSearch(parsed.params);
    res.json(out);
  } catch (e) {
    console.error('[runSearch]', e.message);
    res.status(500).json({ error: 'Errore interno durante la ricerca' });
  }
});

require('./registrazioni-route').mount(app, { json: express.json({ limit: '4kb' }), chiaveLimite, clientIp });

require('./dati-utente').mount(app, { json: express.json({ limit: '8kb' }), utenteDi: req => req.authId || 'owner', chiaveLimite });

require('./scheda-veicolo-route').mount(app, { chiaveLimite });

require('./richiami-route').mount(app, { chiaveLimite });

require('./targa').mount(app, { json: express.json({ limit: '2kb' }), chiaveLimite });

require('./fonti-route').mount(app, { chiaveLimite });

require('./prove-route').mount(app, { chiaveLimite });

const amrSearchFn = async (input, utente) => {
  const q = { ...input, tipo: input.tipo || 'auto' };
  let parsed = parseSearchParams(q);
  if (parsed.errors && q.regione) { delete q.regione; parsed = parseSearchParams(q); }
  if (parsed.errors) return { error: parsed.errors.join(', ') };
  parsed.params._cacheScope = utente?.id || 'interno';

  if (utente && utente.ruolo === 'demo' && utente.id) {
    const g = utentiDb.consumaRicerca(String(utente.id), TETTO_GIORNALIERO);
    if (!g.ok) return { tettoEsaurito: { usate: g.usate, max: g.max } };
  }
  const data = await runSearch(parsed.params);
  return { params: parsed.params, risultati: data.risultati || [], sources: data.sources || {} };
};

app.use((err, req, res, next) => {

  if (res.headersSent) return next(err);
  const s = Number(err && (err.status || err.statusCode));
  const codice = Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;

  if (codice < 500) console.warn(`[errore] ${req.method} ${req.path} → ${codice} ${(err && err.name) || 'Error'}`);
  else              console.error(`[errore] ${req.method} ${req.path} → ${codice}`, err);
  res.status(codice).set('Cache-Control', 'no-store').json({
    ok: false,

    error: codice < 500 && err && err.message ? String(err.message) : 'Errore interno del server. Riprova fra poco.',
  });
});

const avviaAscolto = require.main === module;
if (avviaAscolto && auth.stato() === 'assente') {
  console.error('\n  AMR non parte: non c\'e\' nessuna password impostata.\n');
  console.error('  Il server ascolta sulla rete e l\'esposizione pubblica puo\' essere rimasta accesa:');
  console.error('  senza password chiunque arrivi alla porta entra. Impostala e riprova:\n');
  console.error('      node scripts/set-password.js\n');
  process.exit(1);
}
const server = !avviaAscolto ? null : app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);

});

module.exports = { server, app, _lookupBrand: lookupBrand, _lookupModelGroup: lookupModelGroup, _catalogResolver: catalogResolver,

  _gateAuth: gateAuth, _postLogin: postLogin, _loginAttempts: loginAttempts, _cacheable: cacheable,
  _percorsoGate: percorsoGate, _soloOwner: soloOwner, _SOLO_OWNER: SOLO_OWNER, _AUTH_FREE: AUTH_FREE,
  _tettoGiornaliero: tettoGiornaliero, _TETTO_GIORNALIERO: TETTO_GIORNALIERO, _amrSearchFn: amrSearchFn,

  _tailscalePublicUrl: tailscalePublicUrl,

  _clientIp: clientIp, _chiaveLimite: chiaveLimite,

  _runSource: runSource, _runSubito: runSubito,
  _as24LivelloAllargamento: as24LivelloAllargamento };
