'use strict';
// Usare con NODE_OPTIONS=--require=./test/no-dotenv-preload.cjs quando una prova
// importa server.js: i test non devono caricare le credenziali locali da .env.
require('dotenv').config = () => ({ parsed: {} });
