# Avvistamenti ADS-B da Home Assistant

Le reti ADS-B gratuite (adsb.lol, airplanes.live, adsb.fi) e OpenSky non rispondono ai Worker Cloudflare: la raccolta
degli aerei attorno agli aeroporti gira quindi a casa, su Home Assistant (Raspberry Pi), ogni 3 minuti.

1. Su Cloudflare, Worker `tabelloni-voli` → Settings → Variables and Secrets: aggiungi il segreto `SEEN_KEY` (una
   stringa casuale lunga).
2. In Home Assistant (add-on File editor o Studio Code Server) crea `/config/adsb_push.sh` con il contenuto di
   `adsb_push.sh`, mettendo la stessa chiave al posto di `METTI_QUI_LA_CHIAVE`.
3. In `/config/configuration.yaml` aggiungi:

   ```yaml
   shell_command:
     adsb_push: "sh /config/adsb_push.sh"
   ```

4. Riavvia Home Assistant, poi crea un'automazione (Impostazioni → Automazioni → Nuova → Modifica in YAML):

   ```yaml
   alias: Avvistamenti aerei per tabelloni-voli
   triggers:
     - trigger: time_pattern
       minutes: "/3"
   actions:
     - action: shell_command.adsb_push
   mode: single
   ```

Controllo: `https://tabelloni-voli.giuseppe-bagliesi.workers.dev/seen?airport=PSA&day=AAAA-MM-GG` deve mostrare
`lastPush` recente e `polls` che cresce.
