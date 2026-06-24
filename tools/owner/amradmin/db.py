"""Connessione Postgres DB-pura.

Legge `DATABASE_URL` dal `.env` del repo (mai hardcoded), connette via lo stesso
socket /tmp che usa l'app Node (backend/db/index.js). Espone una classe `Db`
sottile con `rows()`/`one()`/`execute()` e riconnessione.
"""
from __future__ import annotations

import re
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

# tools/owner/amradmin/db.py → parents[3] = radice repo
REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_PATH = REPO_ROOT / ".env"


def read_database_url(env_path: Path = ENV_PATH) -> str:
    """Estrae DATABASE_URL dal .env. Solleva se assente (fail-loud).

    Tollera il prefisso `export ` e un commento inline ` # ...` (convenzione
    dotenv), ma SOLO se il valore non è quotato (le password potrebbero contenere #).
    """
    if not env_path.is_file():
        raise FileNotFoundError(f".env non trovato in {env_path}")
    for line in env_path.read_text().splitlines():
        m = re.match(r"\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$", line)
        if not m:
            continue
        val = m.group(1)
        if val[:1] not in "\"'":
            val = re.split(r"\s+#", val, maxsplit=1)[0].rstrip()   # togli commento inline
        return val.strip().strip('"').strip("'")
    raise KeyError("DATABASE_URL non presente nel .env")


class Db:
    """Connessione persistente (autocommit) con helper dict-row e riconnessione.

    Letture in autocommit (nessuna tx lunga → non blocca il crawler che scrive).
    Le scritture usano `tx()` per un blocco transazionale esplicito.
    """

    # Limiti per non bloccare la UI all'infinito (vedi app.py: query off-loop).
    CONNECT_TIMEOUT = 5          # secondi per stabilire la connessione
    STATEMENT_TIMEOUT_MS = 15000  # tetto per singola query (lock col crawler ecc.)

    def __init__(self, url: str | None = None):
        # Lettura .env LAZY (alla prima conn) → costruire Db non può crashare
        # prima che la UI sia montata; l'errore emerge nel try/except del refresh.
        self.url = url
        self._conn: psycopg.Connection | None = None

    def conn(self) -> psycopg.Connection:
        if self._conn is None or self._conn.closed:
            if self.url is None:
                self.url = read_database_url()
            self._conn = psycopg.connect(
                self.url, autocommit=True, row_factory=dict_row,
                connect_timeout=self.CONNECT_TIMEOUT,
            )
            self._conn.execute(f"SET statement_timeout = {self.STATEMENT_TIMEOUT_MS}")
        return self._conn

    def rows(self, sql: str, params=None) -> list[dict]:
        with self.conn().cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def one(self, sql: str, params=None) -> dict | None:
        with self.conn().cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def execute(self, sql: str, params=None) -> int:
        """Esegue una scrittura (autocommit). Ritorna rowcount."""
        with self.conn().cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    def tx(self):
        """Context manager transazionale per scritture multi-statement atomiche."""
        return self.conn().transaction()

    def close(self) -> None:
        if self._conn is not None and not self._conn.closed:
            self._conn.close()

    def __enter__(self) -> "Db":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
