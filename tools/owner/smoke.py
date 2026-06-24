"""Smoke read-only: esegue ogni query sul DB live e stampa i risultati.
Uso:  tools/owner/.venv/bin/python tools/owner/smoke.py
"""
from amradmin import queries as Q
from amradmin.db import Db


def main() -> None:
    with Db() as db:
        c = Q.counts(db)
        print(f"counts: total={c['total']} crawlati={c['crawlati']} mai={c['mai']}")
        assert c["total"] == c["crawlati"] + c["mai"], "invariante counts rotta"

        print("nodeStats:")
        for r in Q.node_stats(db):
            print(f"  {r['node']:<8} tot={r['total']:<6} mai={r['mai']} due={r['due']} "
                  f"fresco={r['fresco']} spenti={r['spenti']} ultimo_crawl={r.get('last_run')}")

        print("listingsByFonte:")
        for r in Q.listings_by_fonte(db):
            print(f"  {r['fonte']:<10} tot={r['total']:<7} active={r['active']:<7} gone={r['gone']}")

        h = Q.health(db)
        print(f"health: ok={h['ok']} blocked={h['blocked']} degraded={h['degraded']} nodi={len(h['nodi'])}")

        lr = Q.last_run(db, "imac")
        print(f"lastRun(imac): {lr['written'] if lr else '—'} scritti / "
              f"{lr['targets'] if lr else '—'} target")

        print("runs_history (3):")
        for r in Q.runs_history(db, limit=3):
            print(f"  #{r['id']} {r['node']} t={r['targets']} w={r['written']} e={r['errors']}")

        print("coverage marca×regione (top 5 auto):")
        for r in Q.coverage_marca_regione(db, tipo="auto", limit=5):
            print(f"  {r['marca']:<14} {r['regione']:<12} {r['n']}")

        sg = Q.suggestions(db, limit=6)
        print(f"suggeriti da crawlare: {len(sg)} · primi:")
        for r in sg:
            stato = "mai" if r.get("mai") else (f"{r['coverage_pct']}%" if r.get("coverage_pct") is not None else "-")
            print(f"  {r['tipo']:<4} {r['marca']:<12} {r['modello']:<16} {stato:<6} pri={r['priority']}")

        pd = Q.price_distribution(db, "auto", "Fiat", "500")
        if pd and pd["n"]:
            print(f"prezzi Fiat 500 attivi: n={pd['n']} p25={pd['p25']} med={pd['mediana']} "
                  f"p75={pd['p75']} [{pd['minimo']}–{pd['massimo']}]")
        print("\nSMOKE OK")


if __name__ == "__main__":
    main()
