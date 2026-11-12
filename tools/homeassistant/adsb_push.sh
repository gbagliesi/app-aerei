#!/bin/sh
# Raccoglitore degli avvistamenti ADS-B per il Worker tabelloni-voli (gira su Home Assistant ogni 3 minuti).
# Chiede al Worker quali aeroporti guardare, poi per ognuno prende da adsb.lol gli aerei entro 25 miglia
# e li manda al Worker. La chiave deve essere uguale al segreto SEEN_KEY del Worker.
W="https://tabelloni-voli.giuseppe-bagliesi.workers.dev"
K="METTI_QUI_LA_CHIAVE"
curl -s -m 20 "$W/seen/targets?key=$K" | while read -r AP LAT LON; do
  [ -n "$LON" ] || continue
  curl -s -m 15 "https://api.adsb.lol/v2/point/$LAT/$LON/25" \
    | curl -s -m 15 -X POST -H "Content-Type: application/json" --data-binary @- "$W/seen/push?airport=$AP&key=$K" > /dev/null
done
