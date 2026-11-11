# Worker Cloudflare per i tabelloni ufficiali

L'app gira nel browser, che non può leggere direttamente i tabelloni dei siti degli aeroporti.
Questo piccolo Worker (gratuito) li legge al posto suo e li restituisce all'app.

Aeroporti supportati: **Pisa (PSA)**, **Firenze (FLR)**, **Fiumicino (FCO)**, **Ciampino (CIA)**, **Bari, Brindisi, Foggia, Taranto**,
**Milano Malpensa (MXP)** e **Linate (LIN)**, **Bologna (BLQ)**, **Catania (CTA)**, **Palermo (PMO)**,
**Torino (TRN)**, **Cagliari (CAG)**, **Ginevra (GVA)**, **Zurigo (ZRH)**, **Francoforte (FRA)**, **Monaco (MUC)**,
**Madrid (MAD)**, **Barcellona (BCN)**, **Lisbona (LIS)**, **Londra Gatwick (LGW)**, **Stansted (STN)**, **Luton (LTN)**, **City (LCY)**,
**Lione (LYS)**, **Parigi Beauvais (BVA)**, **Amsterdam (AMS)**, **Genova (GOA)**, **Venezia (VCE)**, **Hong Kong (HKG)**.

Fonti (tutte pubbliche, usate dai siti o dalle app degli aeroporti):
- Pisa, Firenze: API dei siti di Toscana Aeroporti. Puglia: backend dell'app ufficiale. Ginevra: feed dell'app.
- Fiumicino, Ciampino: pagina "Voli in tempo reale" di adr.it (HTML).
- Milano: API SEA dei siti milanomalpensa-airport.com / milanolinate-airport.com (header `keyId`, la chiave pubblica del sito;
  se SEA la cambia, impostala nella variabile `SEA_KEY_ID` del Worker).
- Zurigo: `flightdata.flughafen-zuerich.ch/flights` (JSON). Francoforte: JSON del sito frankfurt-airport.com.
- Catania: API GraphQL del sito aeroporto.catania.it. Monaco, Palermo, Bologna: tabelloni HTML dei siti.
- Madrid, Barcellona: tabellone di aena.es. Lisbona: proxy voli di aeroportolisboa.pt. Cagliari: JSON di sogaer.it.
  Torino, Luton, Beauvais: tabelloni HTML dei siti. Gatwick: FetchFlights del sito. Stansted: API GraphQL del sito.
  London City: API voli del sito. Lione: `/api/flights/list` di lyonaeroports.com.
- Amsterdam: Public Flight API 4.2 ufficiale di Schiphol (developer.schiphol.nl, token OAuth). Client ID e secret dell'app, salvati
  come segreti del Worker `SCHIPHOL_APP_ID` e `SCHIPHOL_APP_KEY` (Settings → Variables and Secrets, tipo Secret).
- Non disponibili (protezioni anti-bot o chiave/registrazione): Napoli, Orio al Serio, Olbia, Alghero,
  Heathrow, Parigi CDG/Orly.

Dati: gate, check-in, nastro, orario stimato e stato (dove l'aeroporto li pubblica); marche dell'aereo per Milano,
Ginevra, Zurigo e Francoforte. Monaco non pubblica il gate nell'elenco; Palermo e Bologna solo i voli di oggi.

## Notifiche sui voli seguiti (dalla v3.9)

Il Worker contiene anche un Durable Object `Watcher` (file [`notify.js`](notify.js), configurazione in [`wrangler.toml`](wrangler.toml))
che conserva i voli scelti con 🔔 nell'app, li controlla ogni 2 minuti (da 4 ore prima della partenza, solo quando c'è qualcosa
da seguire) e manda le notifiche Web Push al telefono o al computer, anche ad app chiusa.
- Fonti: prima i tabelloni ufficiali di partenza e arrivo (letti dal Worker stesso con la cache di `/board`); AeroDataBox solo
  per quello che i tabelloni non coprono, al massimo una chiamata ogni 8 minuti e 30 per volo. La chiave AeroDataBox è quella
  mandata dall'app (se lo consenti) oppure il segreto facoltativo `ADB_KEY` del Worker.
- Le chiavi VAPID per il Web Push le crea il Worker al primo uso e restano nel Durable Object: non serve configurare niente.
- Si pubblica con il workflow **Deploy Worker** (usa `wrangler.toml`); a mano: `npx wrangler deploy --config worker/wrangler.toml --keep-vars`.
  Incollare il codice nella dashboard non basta più (servono `notify.js` e il Durable Object).

## FlightAware AeroAPI (dalla v4.4)

File [`aeroapi.js`](aeroapi.js). Serve come riserva quando AeroDataBox non risponde (volo per numero, voli di un aereo
dalle marche) e per trovare l'aereo in arrivo (`inbound_fa_flight_id`), anche per le low cost.
- `GET /fa?ident=FR1234&date=YYYY-MM-DD[&inbound=1]`, `GET /fa?reg=EI-ABC&date=YYYY-MM-DD`, `GET /fa/usage`.
- Segreto del Worker `AEROAPI_KEY` (chiave del portale AeroAPI, piano Personal). Senza segreto `/fa` risponde 501 e l'app lo ignora.
- Ogni richiesta si paga (piano Personal: primi 5 $ al mese gratis). Cache 10 minuti nel Worker e nel browser; limite
  `AEROAPI_MAX_MONTH` richieste al mese (variabile facoltativa, predefinito 800), contato nel Durable Object `Watcher`.

## Pubblicarlo (una volta sola, ~5 minuti)

1. Entra su [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**.
2. Nome: `tabellone-voli` → **Deploy**.
3. Premi **Edit code**, cancella tutto il codice di esempio e incolla il contenuto di [`worker.js`](worker.js) → **Deploy**.
4. Copia l'indirizzo del Worker (tipo `https://tabellone-voli.TUONOME.workers.dev`).
5. Nell'app: ⚙︎ Impostazioni → incolla l'indirizzo nel campo del Worker → **Prova il Worker** → **Salva**.

## Verifica e diagnostica

- `https://…workers.dev/board?airport=PSA&nature=D` — partenze di Pisa (`nature=A` per gli arrivi)
- `https://…workers.dev/debug?airport=FLR&nature=D` — mostra l'indirizzo letto, i tempi e l'inizio della risposta
- `https://…workers.dev/trace?hex=4ca123` — percorso volato nelle ultime ~24 ore da un aereo (ICAO24), dalle tracce ADS-B pubbliche di adsb.lol, ridotto all'essenziale (cache 60 s); lo usa la pagina dell'aereo quando il browser non può leggere il file direttamente

Di default il Worker risponde solo all'app su `https://gbagliesi.github.io` e a `http://localhost:8000`.
Per cambiarlo aggiungi in **Settings → Variables** una variabile `ALLOWED_ORIGINS` con gli indirizzi separati da virgola.

Le risposte restano in cache 90 secondi: l'aeroporto riceve al massimo poche richieste al minuto.

## Copia giornaliera dei tabelloni (dalla v4.6)

Molti siti mostrano solo i voli di oggi o poche ore attorno a adesso. Il Worker salva una copia di ogni tabellone ufficiale letto
(al massimo ogni 15 minuti per aeroporto) nel Durable Object, istanza `snapshots` (file [`snapshots.js`](snapshots.js)), e ogni ora
(cron `17 * * * *` in `wrangler.toml`) rilegge i tabelloni degli aeroporti consultati negli ultimi 3 giorni. Si tengono 4 giorni.
- `GET /snap?airport=PSA&nature=A&day=2026-11-10` → `{ flights: [...] }` (stesso formato di `/board`, giorno locale dell'aeroporto).
- L'app la usa per sapere quali aerei sono arrivati la sera prima e sono rimasti a terra la notte, e per ricostruire la giornata delle
  compagnie (aereo in arrivo e marche ipotizzate).
