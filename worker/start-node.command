#!/bin/bash
# Doppio-click su Mac (massimo). Avvia il launcher nodo in loop.
cd "$(dirname "$0")/.." && exec node worker/node-start.js
