'use strict';

(() => {
  const root = document.querySelector('[data-backup-prototipo]');
  if (!root) return;
  const stato = root.querySelector('[data-backup-stato]');
  const avviso = root.querySelector('[data-backup-avviso]');
  const aggiorna = root.querySelector('[data-backup-aggiorna]');
  const riprova = root.querySelector('[data-backup-riprova]');
  let admin = false, versione = 0, attesa = null;
  const etichette = { non_configurato: 'Non configurato', pending: 'In attesa',
    errore: 'Copia non confermata', confermato: 'Copia confermata' };
  const data = valore => valore && Number.isFinite(Date.parse(valore))
    ? new Date(valore).toLocaleString('it-IT') : 'Nessuna copia confermata';
  async function leggi(url, options = {}) {
    const r = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(10000), ...options });
    if (!r.ok) throw new Error('backup_non_disponibile');
    return r.json();
  }
  function mostra(d) {
    const elenco = ['non_configurato','pending','errore','confermato'];
    const n = valore => Number.isSafeInteger(valore) && valore >= 0;
    const tempo = valore => valore === null || (typeof valore === 'string' && Number.isFinite(Date.parse(valore)));
    if (!d || typeof d.configurato !== 'boolean' || typeof d.avviso !== 'boolean'
        || typeof d.retentionApplicata !== 'boolean' || !n(d.operazioniPreesistenti)
        || !d.journal || !d.database || !elenco.includes(d.journal.stato) || !elenco.includes(d.database.stato)
        || ![d.journal.pending,d.journal.failed,d.journal.confirmed].every(n)
        || !tempo(d.journal.ultimo) || !tempo(d.database.ultimo)
        || (d.database.stato === 'confermato' && d.database.ultimo === null)) {
      throw new Error('backup_non_disponibile');
    }
    const nonConfermato = d.avviso || !d.configurato || !d.retentionApplicata || d.operazioniPreesistenti > 0
      || d.journal.stato !== 'confermato' || d.database.stato !== 'confermato'
      || d.journal.pending > 0 || d.journal.failed > 0;
    stato.replaceChildren();
    for (const [nome, valore] of [['Journal', d.journal], ['Database', d.database]]) {
      const titolo = document.createElement('dt'), testo = document.createElement('dd');
      titolo.textContent = nome;
      testo.textContent = (etichette[valore?.stato] || 'Stato non confermato') + ' · ' + data(valore?.ultimo);
      if (nome === 'Journal') testo.textContent += ' · in attesa: ' + (valore?.pending ?? 'non noto')
        + ' · fallite: ' + (valore?.failed ?? 'non noto');
      stato.append(titolo, testo);
    }
    avviso.textContent = nonConfermato ? (d.configurato
      ? 'Attenzione: una copia o la retention non è confermata. Le operazioni commerciali restano disponibili.'
      : 'Backup esterno non configurato: le operazioni proseguono, ma la copia di sicurezza non è confermata.')
      : 'Copie confermate. L’ultimo restore deve comunque essere verificato separatamente.';
    if (d.operazioniPreesistenti) avviso.textContent += ' Operazioni precedenti senza journal: ' + d.operazioniPreesistenti + '.';
    root.classList.toggle('warning', !!nonConfermato);
  }
  function refresh() {
    if (!admin || attesa) return attesa;
    const v = versione;
    aggiorna.disabled = true;
    const richiesta = leggi('/api/auth/backup/stato').then(d => {
      if (admin && v === versione) mostra(d);
    }).catch(() => {
      if (admin && v === versione) {
        avviso.textContent = 'Stato backup non disponibile. Nessuna nuova copia è confermata: aggiorna per riprovare.';
        root.classList.add('warning');
      }
    }).finally(() => {
      if (attesa === richiesta) attesa = null;
      if (v === versione) aggiorna.disabled = false;
    });
    attesa = richiesta;
    return richiesta;
  }
  function applicaAccount(c) {
    versione++; admin = c?.admin === true; root.hidden = !admin;
    attesa = null; stato.replaceChildren(); avviso.textContent = ''; aggiorna.disabled = false;
    riprova.disabled = false;
    if (admin) void refresh();
  }
  document.addEventListener('amr:account', e => applicaAccount(e.detail));
  const iniziale = versione;
  void leggi('/api/auth/me').then(c => { if (versione === iniziale) applicaAccount(c); }).catch(() => {});
  aggiorna.addEventListener('click', refresh);
  riprova.addEventListener('click', async () => {
    if (!admin || riprova.disabled) return;
    const v = ++versione; attesa = null; riprova.disabled = true;
    try {
      await leggi('/api/auth/backup/riprova', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}' });
      if (admin && v === versione) {
        avviso.textContent = 'Nuovo tentativo richiesto. Copia ancora da confermare.';
        await refresh();
      }
    } catch {
      if (admin && v === versione) avviso.textContent = 'Richiesta non confermata. Aggiorna lo stato prima di riprovare.';
    } finally { if (v === versione) riprova.disabled = false; }
  });
  setInterval(() => { if (!root.hidden) void refresh(); }, 10000);
})();
