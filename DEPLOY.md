# Deployment (VPS + Docker + bestehende nginx)

Server und Frontend laufen als **zwei getrennte Container**, beide nur an
`127.0.0.1` gebunden. Deine **bereits laufende Host-nginx** sitzt davor,
terminiert TLS (Let's Encrypt) und leitet weiter:

```
                 Internet (443, TLS)
                        │
                  Host-nginx  ──────────────  Let's Encrypt (certbot)
                   /            \
        /ws  →  127.0.0.1:8090    /  →  127.0.0.1:8091
        (server-Container)            (client-Container, nginx static)
```

Kein Container öffnet einen öffentlichen Port — nur die Host-nginx ist von außen
erreichbar.

## 1. Voraussetzungen

- Docker + Docker Compose auf dem VPS.
- Eine **DNS-A-(und AAAA-)Record** für `arena-mech-fight.olivier.berlin`, der
  auf die öffentliche IP des VPS zeigt. Das muss **vor** certbot stehen, sonst
  schlägt die Let's-Encrypt-Validierung fehl.
- `certbot` mit nginx-Plugin (`sudo apt install certbot python3-certbot-nginx`).

## 2. Container bauen & starten

```bash
cp .env.example .env          # bei Bedarf Ports anpassen
docker compose up -d --build
```

Prüfen:

```bash
docker compose ps                              # beide healthy?
curl -s http://127.0.0.1:8090/health           # -> ok   (server)
curl -sI http://127.0.0.1:8091/ | head -1      # -> 200  (frontend)
```

## 3. Host-nginx einrichten

```bash
sudo cp deploy/nginx/arena-mech-fight.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/arena-mech-fight.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> Die Ports in der Site-Config (`8090`/`8091`) müssen zu `SERVER_PORT` /
> `CLIENT_PORT` aus deiner `.env` passen.

## 4. Let's Encrypt aktivieren

```bash
sudo certbot --nginx -d arena-mech-fight.olivier.berlin
```

certbot holt das Zertifikat, ergänzt die Site automatisch um den
`listen 443 ssl`-Block samt HTTP→HTTPS-Weiterleitung und richtet die
automatische Erneuerung ein (systemd-Timer). Danach läuft alles über
`https://` bzw. `wss://` — der Client erkennt das von selbst und verbindet sich
zu `wss://arena-mech-fight.olivier.berlin/ws`.

Fertig: **https://arena-mech-fight.olivier.berlin** aufrufen.

## 5. Updaten / Neustarten

```bash
git pull
docker compose up -d --build      # baut nur geänderte Images neu
docker compose logs -f server     # strukturierte JSON-Logs

docker compose down               # stoppen
```

## Was an Härtung drinsteckt

**Container (`docker-compose.yml`):**
- Server läuft als non-root `node`-User, Frontend als unprivilegierte nginx
  (UID 101).
- `read_only` Root-Dateisystem, `cap_drop: ALL`, `no-new-privileges`.
- `pids_limit` + `mem_limit` begrenzen DoS-Schaden.
- Ports nur an `127.0.0.1` — Container sind nicht direkt aus dem Internet
  erreichbar.

**Server-Code:**
- `maxPayload` (16 KiB) auf dem WebSocket-Server — große Frames werden schon
  auf ws-Ebene abgewiesen.
- `MAX_CONNECTIONS` (Default 500) begrenzt gleichzeitige Verbindungen.
- Heartbeat-Ping beendet tote/halb-offene Sockets; ein Hello-Timeout (15 s)
  wirft stumme Verbindungen raus.
- `/debug/state` ist via `DEBUG_STATE=false` abgeschaltet **und** wird von der
  Host-nginx ohnehin nicht nach außen geroutet.

**Host:**
- nginx terminiert TLS und ist der einzige öffentliche Einstiegspunkt;
  `client_max_body_size 64k` deckelt Request-Bodies.

Hintergrund zur Sicherheitslage steht im Repo-Verlauf — der Anwendungscode hat
keinen Code-Execution-Pfad aus Client-Input.
