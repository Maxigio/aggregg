-- Schema usa-e-getta del collaudo: non è una migrazione di produzione AMR.
-- Le connessioni concorrenti devono prendere il lock PRIMA di contare i posti.
CREATE SCHEMA amr_prova;
CREATE TABLE amr_prova.aziende(id integer PRIMARY KEY);
INSERT INTO amr_prova.aziende VALUES (1);
CREATE TABLE amr_prova.membri(persona text PRIMARY KEY, azienda integer NOT NULL REFERENCES amr_prova.aziende);
INSERT INTO amr_prova.membri VALUES ('referente',1),('collega',1);
CREATE TABLE amr_prova.inviti(email text PRIMARY KEY, azienda integer NOT NULL REFERENCES amr_prova.aziende);
CREATE FUNCTION amr_prova.prenota(destinatario text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM amr_prova.aziende WHERE id=1 FOR UPDATE;
  IF (SELECT count(*) FROM amr_prova.membri WHERE azienda=1)
     + (SELECT count(*) FROM amr_prova.inviti WHERE azienda=1) >= 3 THEN
    RAISE EXCEPTION 'quota raggiunta';
  END IF;
  INSERT INTO amr_prova.inviti VALUES (destinatario,1);
END;
$$;
REVOKE ALL ON SCHEMA amr_prova FROM PUBLIC;
REVOKE ALL ON FUNCTION amr_prova.prenota(text) FROM PUBLIC;
CREATE ROLE amr_collaudo_senza_permessi NOLOGIN NOSUPERUSER NOBYPASSRLS;
