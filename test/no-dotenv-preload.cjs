'use strict';
// Caricato da `npm test` con --require per tutta la suite: i test che importano
// server.js (o altri moduli che chiamano dotenv) non devono caricare le
// credenziali locali da .env.
require('dotenv').config = () => ({ parsed: {} });
