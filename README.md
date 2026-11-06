# Tabellone Voli

App web installabile (PWA) per seguire i voli: tabelloni partenze/arrivi con gate per ogni aeroporto,
dettaglio del volo con tracking in tempo reale su mappa, l'aereo "in arrivo" che farà il volo
(tratta precedente dello stesso aeromobile) con il suo tracking, e preferiti per aeroporti, tratte e voli.

## Funzioni
- **Tabellone** per aeroporto (codice IATA): partenze e arrivi da 2 ore fa a 10 ore avanti, orario previsto/stimato,
  terminal, gate, nastro bagagli, stato, filtro per città/volo/compagnia, aggiornamento automatico.
- **Volo**: orari, gate, terminal, check-in, nastro, aeromobile (marche, modello, ICAO24), avanzamento,
  mappa con rotta e posizione live.
- **Da dove arriva l'aereo**: la tratta precedente dello stesso aeromobile, il suo stato, il tempo di rotazione
  (con avviso se è stretto) e la posizione live dell'aereo mentre vola verso il tuo aeroporto.
- **Preferiti** (☆): aeroporti, tratte (con vista dedicata e tratta inversa) e voli; esportabili/importabili in JSON.
- **Modalità demo** con voli simulati e coerenti, per provarla senza chiave API.

## Fonti dati
| Uso | Fonte | Costo |
|---|---|---|
| Tabelloni, voli per numero, voli per aeromobile | [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) via RapidAPI | piano gratuito limitato, piani base a pochi €/mese |
| Posizione live | AeroDataBox, poi [adsb.lol](https://api.adsb.lol) e [OpenSky Network](https://opensky-network.org) | gratis, senza chiave |

La chiave RapidAPI si inserisce in **Impostazioni** e resta salvata solo nel browser.

## Avvio
Sono file statici, senza build:

```bash
python3 -m http.server 8000   # poi apri http://localhost:8000
```

Si può pubblicare gratis su GitHub Pages (Settings → Pages → branch `main`, cartella root).
Da telefono: apri il sito e usa "Aggiungi a schermata Home" per installarla come app.

## Struttura
- `index.html`, `style.css` – interfaccia
- `js/app.js` – pagine e navigazione (hash router)
- `js/api.js` – AeroDataBox, tracking live, ricerca della tratta precedente
- `js/demo.js` – generatore di voli simulati
- `js/store.js` – preferiti e impostazioni (localStorage)
- `js/airports.js` – elenco aeroporti per ricerca e mappa
- `sw.js`, `manifest.webmanifest` – installazione PWA e uso offline dell'interfaccia
- `vendor/` – Leaflet 1.9.4 (mappe)
