// Piccolo database locale di aeroporti: usato per autocompletamento, mappa e modalità demo.
// Con AeroDataBox attivo, qualunque codice IATA funziona (le coordinate mancanti vengono richieste all'API).
export const AIRPORTS = [
  ['FCO','LIRF','Roma Fiumicino','Roma',41.8003,12.2389],
  ['CIA','LIRA','Roma Ciampino','Roma',41.7994,12.5949],
  ['MXP','LIMC','Milano Malpensa','Milano',45.6306,8.7281],
  ['LIN','LIML','Milano Linate','Milano',45.4451,9.2767],
  ['BGY','LIME','Bergamo Orio al Serio','Bergamo',45.6739,9.7042],
  ['VCE','LIPZ','Venezia Marco Polo','Venezia',45.5053,12.3519],
  ['BLQ','LIPE','Bologna Marconi','Bologna',44.5354,11.2887],
  ['PSA','LIRP','Pisa Galilei','Pisa',43.6839,10.3927],
  ['FLR','LIRQ','Firenze Peretola','Firenze',43.8100,11.2051],
  ['NAP','LIRN','Napoli Capodichino','Napoli',40.8860,14.2908],
  ['CTA','LICC','Catania Fontanarossa','Catania',37.4668,15.0664],
  ['PMO','LICJ','Palermo Falcone Borsellino','Palermo',38.1760,13.0910],
  ['BRI','LIBD','Bari Karol Wojtyła','Bari',41.1389,16.7606],
  ['CAG','LIEE','Cagliari Elmas','Cagliari',39.2515,9.0543],
  ['TRN','LIMF','Torino Caselle','Torino',45.2008,7.6496],
  ['LHR','EGLL','London Heathrow','Londra',51.4700,-0.4543],
  ['LGW','EGKK','London Gatwick','Londra',51.1537,-0.1821],
  ['CDG','LFPG','Paris Charles de Gaulle','Parigi',49.0097,2.5479],
  ['ORY','LFPO','Paris Orly','Parigi',48.7262,2.3652],
  ['AMS','EHAM','Amsterdam Schiphol','Amsterdam',52.3105,4.7683],
  ['FRA','EDDF','Frankfurt','Francoforte',50.0379,8.5622],
  ['MUC','EDDM','München','Monaco di Baviera',48.3538,11.7861],
  ['ZRH','LSZH','Zürich','Zurigo',47.4582,8.5555],
  ['VIE','LOWW','Wien Schwechat','Vienna',48.1103,16.5697],
  ['MAD','LEMD','Madrid Barajas','Madrid',40.4983,-3.5676],
  ['BCN','LEBL','Barcelona El Prat','Barcellona',41.2974,2.0833],
  ['LIS','LPPT','Lisboa Humberto Delgado','Lisbona',38.7742,-9.1342],
  ['ATH','LGAV','Athens Eleftherios Venizelos','Atene',37.9364,23.9445],
  ['IST','LTFM','Istanbul','Istanbul',41.2753,28.7519],
  ['DXB','OMDB','Dubai International','Dubai',25.2532,55.3657],
  ['DOH','OTHH','Doha Hamad','Doha',25.2731,51.6081],
  ['JFK','KJFK','New York JFK','New York',40.6413,-73.7781],
  ['EWR','KEWR','Newark Liberty','New York',40.6895,-74.1745],
  ['BRU','EBBR','Brussels','Bruxelles',50.9014,4.4844],
  ['CPH','EKCH','Copenhagen Kastrup','Copenaghen',55.6180,12.6508],
  ['DUB','EIDW','Dublin','Dublino',53.4264,-6.2499],
  ['TIA','LATI','Tirana','Tirana',41.4147,19.7206],
  ['MLA','LMML','Malta','Malta',35.8575,14.4775],
  ['CAI','HECA','Cairo','Il Cairo',30.1219,31.4056],
  ['TLV','LLBG','Tel Aviv Ben Gurion','Tel Aviv',32.0055,34.8854],
].map(([iata, icao, name, city, lat, lon]) => ({ iata, icao, name, city, lat, lon }));

const byIata = new Map(AIRPORTS.map(a => [a.iata, a]));
export const airportByIata = code => byIata.get((code || '').toUpperCase());

export function searchAirports(q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return [];
  return AIRPORTS.filter(a =>
    a.iata.toLowerCase().startsWith(q) || a.icao.toLowerCase().startsWith(q) ||
    a.name.toLowerCase().includes(q) || a.city.toLowerCase().includes(q)
  ).slice(0, 8);
}
