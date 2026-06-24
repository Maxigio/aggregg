"""Spawn del drainer Node one-shot (scripts/crawl-once.js).

UNICA azione NON-DB del tool, isolata e documentata. Lo spawn è STACCATO
(start_new_session) → il crawl SOPRAVVIVE alla chiusura della TUI. Il singleton è
garantito lato drainer (advisory lock Postgres): un 2º spawn esce subito (no-op).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .db import REPO_ROOT, read_database_url

# `which node` sull'iMac = /usr/local/bin/node; su Apple Silicon è spesso
# /opt/homebrew/bin/node → override OBBLIGATORIO via AMR_NODE_BIN (path non portabile).
NODE_BIN = os.environ.get("AMR_NODE_BIN", "/usr/local/bin/node")
SCRIPT = REPO_ROOT / "scripts" / "crawl-once.js"
LOG_PATH = REPO_ROOT / "data" / "crawl-once.log"


def spawn_drainer() -> int:
    """Lancia il drainer staccato. Ritorna il pid. Idempotente lato drainer:
    se uno è già attivo (advisory lock) il nuovo esce subito."""
    if not Path(NODE_BIN).exists():
        raise FileNotFoundError(
            f"node non trovato in {NODE_BIN} — imposta AMR_NODE_BIN al path corretto "
            f"(es. /opt/homebrew/bin/node su Apple Silicon)")
    if not SCRIPT.is_file():
        raise FileNotFoundError(f"drainer non trovato: {SCRIPT}")
    env = dict(os.environ)
    env["DATABASE_URL"] = read_database_url()      # passato ESPLICITO (no inheritance cieco)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logf = open(LOG_PATH, "a")                      # noqa: SIM115
    try:
        proc = subprocess.Popen(
            [NODE_BIN, str(SCRIPT)],
            cwd=str(REPO_ROOT),                     # crawl-once.js fa dotenv su ../.env
            env=env,
            stdout=logf, stderr=logf, stdin=subprocess.DEVNULL,
            start_new_session=True,                 # detach: nuovo session leader → sopravvive alla TUI
            close_fds=True,
        )
    finally:
        logf.close()                                # il child ha il suo dup del fd → niente FD-leak nel parent
    return proc.pid
