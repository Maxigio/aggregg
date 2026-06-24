#!/bin/bash
# Avvia la dashboard owner-tool da QUALUNQUE cartella (anche doppio-click in Finder).
# Entra nella dir del tool (così `-m amradmin` trova il pacchetto) e usa il suo venv.
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python -m amradmin "$@"
