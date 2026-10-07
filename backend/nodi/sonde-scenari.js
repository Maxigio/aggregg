'use strict';

// Query diagnostiche del proprietario, mai una ricerca di un cliente.
const auto = Object.freeze({ tipo: 'auto', marca: 'Alfa Romeo', modello: 'Giulietta', versione: 'Veloce' });
module.exports = Object.freeze({ subito: auto, autoscout: auto,
  moto: Object.freeze({ tipo: 'moto', marca: 'Fantic', modello: 'Caballero 500', versione: 'Rally' }) });
