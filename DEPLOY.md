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
- Eine **DNS-A-(und AAAA-)Record** für `mech-arena-fight.olivier.berlin`, der
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

## 3. Zertifikat holen (ohne die nginx-Config anzufassen)

```bash
sudo certbot certonly --nginx -d mech-arena-fight.olivier.berlin
```

> **Wichtig:** `certonly` holt nur das Zertifikat und beantwortet die
> HTTP-01-Challenge über die laufende nginx, **schreibt aber keine
> Server-Blöcke**. Das vermeidet die häufigste Stolperfalle von `certbot
> --nginx`: dass certbot einen zweiten Vhost mit gleichem `server_name` in eine
> andere Config packt → konkurrierende Blöcke → HTTPS-Redirect-Loop
> ("Umleitungsfehler"). Siehe Troubleshooting unten.

## 4. Host-nginx einrichten

```bash
sudo cp deploy/nginx/mech-arena-fight.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/mech-arena-fight.conf \
           /etc/nginx/sites-enabled/mech-arena-fight.conf
sudo nginx -t && sudo systemctl reload nginx
```

- Die Ports in der Site-Config (`8090`/`8091`) müssen zu `SERVER_PORT` /
  `CLIENT_PORT` aus deiner `.env` passen.
- `nginx -t` darf **keine** Warnung `conflicting server name … ignored` zeigen —
  dann beanspruchte ein anderer Vhost dieselbe Domain (siehe Troubleshooting).

Gegenchecks:

```bash
curl -sI  http://mech-arena-fight.olivier.berlin/  | grep -iE '^HTTP|^location'  # 301 -> https
curl -sI https://mech-arena-fight.olivier.berlin/  | grep -iE '^HTTP'            # 200, kein location:

# WebSocket end-to-end (erwartet: 101 Switching Protocols):
curl -s -i -N --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  https://mech-arena-fight.olivier.berlin/ws | head -3
```

Fertig: **https://mech-arena-fight.olivier.berlin** aufrufen (zum Testen ein
privates Fenster nehmen — alte Redirects hängen sonst im Cache). Der Client
erkennt TLS selbst und verbindet sich zu `wss://…/ws`.

Die automatische Erneuerung übernimmt der certbot-Timer; ein Reload-Hook hält
nginx aktuell:

```bash
sudo systemctl list-timers | grep certbot      # Renew-Timer aktiv?
echo 'nginx -s reload' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

## 5. Updaten / Neustarten

```bash
git pull
docker compose up -d --build      # baut nur geänderte Images neu
docker compose logs -f server     # strukturierte JSON-Logs

docker compose down               # stoppen
```

## Troubleshooting: „Umleitungsfehler" / Redirect-Loop

Symptom: `https://…/ws` (oder `/`) liefert `301`, der Browser meldet einen
Umleitungsfehler. Ursache ist fast immer ein **zweiter Server-Block mit
demselben `server_name`** — typischerweise von einem früheren `certbot --nginx`,
das den TLS-/Redirect-Block in eine andere Config geschrieben hat.

```bash
# 1) Lädt mehr als ein Block die Domain?  -> "conflicting server name" beim Test
sudo nginx -t

# 2) ALLE Stellen finden, die die Domain beanspruchen:
sudo grep -rIn 'mech-arena-fight' /etc/nginx/

# 3) Den fremden/duplizierten Block (mit dem Redirect) entfernen, sodass NUR
#    deploy/nginx/mech-arena-fight.conf übrig bleibt, dann:
sudo nginx -t && sudo systemctl reload nginx
```

Direkt am Container testen (umgeht die Host-nginx) — kommt hier `101`, ist das
Backend gesund und das Problem liegt eindeutig in der Host-nginx:

```bash
curl -s -i -N --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://127.0.0.1:8090/ws | head -3
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
