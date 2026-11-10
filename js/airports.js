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
  ['BDS','LIBR','Brindisi Papola Casale','Brindisi',40.6576,17.9470],
  ['CAG','LIEE','Cagliari Elmas','Cagliari',39.2515,9.0543],
  ['GOA','LIMJ','Genova Cristoforo Colombo','Genova',44.4133,8.8375],
  ['TRN','LIMF','Torino Caselle','Torino',45.2008,7.6496],
  ['LHR','EGLL','London Heathrow','Londra',51.4700,-0.4543],
  ['LGW','EGKK','London Gatwick','Londra',51.1537,-0.1821],
  ['STN','EGSS','London Stansted','Londra',51.8860,0.2389],
  ['LTN','EGGW','London Luton','Londra',51.8747,-0.3683],
  ['LCY','EGLC','London City','Londra',51.5053,0.0553],
  ['CDG','LFPG','Paris Charles de Gaulle','Parigi',49.0097,2.5479],
  ['ORY','LFPO','Paris Orly','Parigi',48.7262,2.3652],
  ['BVA','LFOB','Paris Beauvais','Parigi',49.4544,2.1128],
  ['LYS','LFLL','Lyon Saint-Exupéry','Lione',45.7256,5.0811],
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
  ['HKG','VHHH','Hong Kong','Hong Kong',22.3080,113.9185],
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
  ['TFS','GCTS','Tenerife Sur','Tenerife',28.0445,-16.5725],
  ['TFN','GCXO','Tenerife Norte','Tenerife',28.4827,-16.3415],
  ['LPA','GCLP','Gran Canaria','Las Palmas',27.9319,-15.3866],
  ['ACE','GCRR','Lanzarote','Lanzarote',28.9455,-13.6052],
  ['FUE','GCFV','Fuerteventura','Fuerteventura',28.4527,-13.8638],
  ['VLC','LEVC','Valencia','Valencia',39.4893,-0.4816],
  ['MAN','EGCC','Manchester','Manchester',53.3537,-2.2750],
  ['EDI','EGPH','Edinburgh','Edimburgo',55.9500,-3.3725],
  ['GLA','EGPF','Glasgow','Glasgow',55.8719,-4.4331],
  ['HAM','EDDH','Hamburg','Amburgo',53.6304,9.9882],
  ['BER','EDDB','Berlin Brandenburg','Berlino',52.3667,13.5033],
  ['CGN','EDDK','Köln/Bonn','Colonia/Bonn',50.8659,7.1427],
  ['STR','EDDS','Stuttgart','Stoccarda',48.6899,9.2220],
  ['FKB','EDSB','Karlsruhe/Baden-Baden','Karlsruhe',48.7794,8.0805],
  ['MST','EHBK','Maastricht Aachen','Maastricht',50.9117,5.7701],
  ['BSL','LFSB','EuroAirport Basel-Mulhouse','Basilea',47.5896,7.5299],
  ['BRN','LSZB','Bern','Berna',46.9141,7.4997],
  ['SXB','LFST','Strasbourg','Strasburgo',48.5383,7.6282],
  ['ARN','ESSA','Stockholm Arlanda','Stoccolma',59.6519,17.9186],
  ['HEL','EFHK','Helsinki-Vantaa','Helsinki',60.3172,24.9633],
  ['WAW','EPWA','Warszawa Chopin','Varsavia',52.1657,20.9671],
  ['KRK','EPKK','Kraków','Cracovia',50.0777,19.7848],
  ['PRG','LKPR','Praha Václav Havel','Praga',50.1008,14.2600],
  ['BUD','LHBP','Budapest Liszt Ferenc','Budapest',47.4298,19.2611],
  ['SKG','LGTS','Thessaloniki','Salonicco',40.5197,22.9709],
  ['HER','LGIR','Heraklion','Heraklion',35.3397,25.1803],
  ['CHQ','LGSA','Chania','Chania',35.5317,24.1497],
  ['LCA','LCLK','Larnaca','Larnaca',34.8751,33.6249],
  ['PFO','LCPH','Paphos','Paphos',34.7180,32.4857],
  ['ZAG','LDZA','Zagreb','Zagabria',45.7429,16.0688],
  ['SPU','LDSP','Split','Spalato',43.5389,16.2980],
  ['DBV','LDDU','Dubrovnik','Dubrovnik',42.5614,18.2682],
  // aggiunti per la pagina dell'aereo (aeroporti dei tabelloni ufficiali e mete frequenti)
  ['GVA','LSGG','Ginevra','Ginevra',46.2381,6.1090],
  ['FOG','LIBF','Foggia Gino Lisa','Foggia',41.4329,15.5350],
  ['TAR','LIBG','Taranto Grottaglie','Taranto',40.5175,17.4032],
  ['TRS','LIPQ','Trieste','Trieste',45.8275,13.4722],
  ['AOI','LIPY','Ancona','Ancona',43.6163,13.3623],
  ['PSR','LIBP','Pescara','Pescara',42.4317,14.1811],
  ['SUF','LICA','Lamezia Terme','Lamezia Terme',38.9054,16.2423],
  ['REG','LICR','Reggio Calabria','Reggio Calabria',38.0712,15.6516],
  ['OLB','LIEO','Olbia Costa Smeralda','Olbia',40.8987,9.5176],
  ['AHO','LIEA','Alghero','Alghero',40.6321,8.2908],
  ['CUF','LIMZ','Cuneo','Cuneo',44.5470,7.6232],
  ['PEG','LIRZ','Perugia','Perugia',43.0959,12.5132],
  ['RMI','LIPR','Rimini','Rimini',44.0203,12.6117],
  ['CIY','LICB','Comiso','Comiso',36.9946,14.6072],
  ['TPS','LICT','Trapani Birgi','Trapani',37.9114,12.4880],
  ['PNL','LICG','Pantelleria','Pantelleria',36.8165,11.9689],
  ['LMP','LICD','Lampedusa','Lampedusa',35.4979,12.6181],
  ['VRN','LIPX','Verona Villafranca','Verona',45.3957,10.8885],
  ['TSF','LIPH','Treviso Canova','Treviso',45.6484,12.1944],
  ['BZO','LIPB','Bolzano','Bolzano',46.4602,11.3264],
  ['QSR','LIRI','Salerno Costa d\'Amalfi','Salerno',40.6204,14.9113],
  ['CRV','LIBC','Crotone','Crotone',38.9972,17.0802],
  ['RAK','GMMX','Marrakech Menara','Marrakech',31.6069,-8.0363],
  ['CMN','GMMN','Casablanca Mohammed V','Casablanca',33.3675,-7.5900],
  ['AGA','GMAD','Agadir Al Massira','Agadir',30.3250,-9.4131],
  ['TNG','GMTT','Tangeri','Tangeri',35.7269,-5.9169],
  ['FEZ','GMFF','Fes Saiss','Fes',33.9273,-4.9779],
  ['RBA','GMME','Rabat Salé','Rabat',34.0515,-6.7515],
  ['TUN','DTTA','Tunisi Cartagine','Tunisi',36.8510,10.2272],
  ['DJE','DTTJ','Djerba Zarzis','Djerba',33.8750,10.7755],
  ['HRG','HEGN','Hurghada','Hurghada',27.1783,33.7994],
  ['SSH','HESH','Sharm el-Sheikh','Sharm el-Sheikh',27.9773,34.3950],
  ['OSL','ENGM','Oslo Gardermoen','Oslo',60.1939,11.1004],
  ['BGO','ENBR','Bergen','Bergen',60.2934,5.2181],
  ['GOT','ESGG','Göteborg Landvetter','Göteborg',57.6628,12.2798],
  ['BLL','EKBI','Billund','Billund',55.7403,9.1518],
  ['AAL','EKYT','Aalborg','Aalborg',57.0928,9.8492],
  ['KEF','BIKF','Reykjavik Keflavik','Reykjavik',63.9850,-22.6056],
  ['RIX','EVRA','Riga','Riga',56.9236,23.9711],
  ['TLL','EETN','Tallinn','Tallinn',59.4133,24.8328],
  ['VNO','EYVI','Vilnius','Vilnius',54.6341,25.2858],
  ['SAW','LTFJ','Istanbul Sabiha Gökçen','Istanbul',40.8986,29.3092],
  ['AYT','LTAI','Antalya','Antalya',36.8987,30.8005],
  ['DLM','LTBS','Dalaman','Dalaman',36.7131,28.7925],
  ['BJV','LTFE','Bodrum Milas','Bodrum',37.2506,27.6643],
  ['ADB','LTBJ','Smirne Adnan Menderes','Smirne',38.2924,27.1570],
  ['ESB','LTAC','Ankara Esenboğa','Ankara',40.1281,32.9951],
  ['NCE','LFMN','Nizza Costa Azzurra','Nizza',43.6584,7.2159],
  ['MRS','LFML','Marsiglia Provenza','Marsiglia',43.4393,5.2214],
  ['TLS','LFBO','Tolosa Blagnac','Tolosa',43.6291,1.3638],
  ['BOD','LFBD','Bordeaux Mérignac','Bordeaux',44.8283,-0.7156],
  ['NTE','LFRS','Nantes Atlantique','Nantes',47.1532,-1.6107],
  ['MLH','LFSB','Mulhouse EuroAirport','Mulhouse',47.5896,7.5299],
  ['OPO','LPPR','Porto','Porto',41.2481,-8.6814],
  ['FAO','LPFR','Faro','Faro',37.0144,-7.9659],
  ['FNC','LPMA','Funchal Madeira','Funchal',32.6979,-16.7745],
  ['PDL','LPPD','Ponta Delgada','Ponta Delgada',37.7412,-25.6979],
  ['AGP','LEMG','Malaga','Malaga',36.6749,-4.4991],
  ['ALC','LEAL','Alicante','Alicante',38.2822,-0.5582],
  ['PMI','LEPA','Palma di Maiorca','Palma di Maiorca',39.5517,2.7388],
  ['IBZ','LEIB','Ibiza','Ibiza',38.8729,1.3731],
  ['MAH','LEMH','Minorca Mahón','Minorca',39.8626,4.2186],
  ['SVQ','LEZL','Siviglia','Siviglia',37.4180,-5.8931],
  ['BIO','LEBB','Bilbao','Bilbao',43.3011,-2.9106],
  ['CRL','EBCI','Bruxelles Charleroi','Charleroi',50.4592,4.4538],
  ['EIN','EHEH','Eindhoven','Eindhoven',51.4501,5.3745],
  ['RTM','EHRD','Rotterdam The Hague','Rotterdam',51.9569,4.4372],
  ['LUX','ELLX','Lussemburgo','Lussemburgo',49.6233,6.2044],
  ['DUS','EDDL','Düsseldorf','Düsseldorf',51.2895,6.7668],
  ['HAJ','EDDV','Hannover','Hannover',52.4611,9.6851],
  ['NUE','EDDN','Norimberga','Norimberga',49.4987,11.0669],
  ['LEJ','EDDP','Lipsia Halle','Lipsia',51.4324,12.2416],
  ['DRS','EDDC','Dresda','Dresda',51.1328,13.7672],
  ['BRS','EGGD','Bristol','Bristol',51.3827,-2.7191],
  ['BHX','EGBB','Birmingham','Birmingham',52.4539,-1.7480],
  ['EMA','EGNX','East Midlands','Nottingham',52.8311,-1.3281],
  ['LPL','EGGP','Liverpool','Liverpool',53.3336,-2.8497],
  ['NCL','EGNT','Newcastle','Newcastle',55.0375,-1.6917],
  ['ABZ','EGPD','Aberdeen','Aberdeen',57.2019,-2.1978],
  ['BFS','EGAA','Belfast International','Belfast',54.6575,-6.2158],
  ['ORK','EICK','Cork','Cork',51.8413,-8.4911],
  ['SNN','EINN','Shannon','Shannon',52.7020,-8.9248],
  ['SZG','LOWS','Salisburgo','Salisburgo',47.7933,13.0043],
  ['INN','LOWI','Innsbruck','Innsbruck',47.2602,11.3440],
  ['GRZ','LOWG','Graz','Graz',46.9911,15.4396],
  ['LNZ','LOWL','Linz','Linz',48.2332,14.1875],
  ['KTW','EPKT','Katowice','Katowice',50.4743,19.0800],
  ['GDN','EPGD','Danzica','Danzica',54.3776,18.4662],
  ['WRO','EPWR','Breslavia','Breslavia',51.1027,16.8858],
  ['POZ','EPPO','Poznań','Poznań',52.4210,16.8263],
  ['BTS','LZIB','Bratislava','Bratislava',48.1702,17.2127],
  ['LJU','LJLJ','Lubiana','Lubiana',46.2237,14.4576],
  ['PUY','LDPL','Pola','Pola',44.8935,13.9222],
  ['BEG','LYBE','Belgrado','Belgrado',44.8184,20.3091],
  ['TGD','LYPG','Podgorica','Podgorica',42.3594,19.2519],
  ['SJJ','LQSA','Sarajevo','Sarajevo',43.8246,18.3315],
  ['SKP','LWSK','Skopje','Skopje',41.9616,21.6214],
  ['OTP','LROP','Bucarest Otopeni','Bucarest',44.5711,26.0850],
  ['CLJ','LRCL','Cluj-Napoca','Cluj-Napoca',46.7852,23.6862],
  ['SOF','LBSF','Sofia','Sofia',42.6967,23.4114],
  ['BOJ','LBBG','Burgas','Burgas',42.5696,27.5152],
  ['VAR','LBWN','Varna','Varna',43.2321,27.8251],
  ['KIV','LUKK','Chișinău','Chișinău',46.9277,28.9310],
  ['TBS','UGTB','Tbilisi','Tbilisi',41.6692,44.9547],
  ['EVN','UDYZ','Yerevan Zvartnots','Yerevan',40.1473,44.3959],
  ['RHO','LGRP','Rodi','Rodi',36.4054,28.0862],
  ['CFU','LGKR','Corfù','Corfù',39.6019,19.9117],
  ['JMK','LGMK','Mykonos','Mykonos',37.4351,25.3481],
  ['JTR','LGSR','Santorini','Santorini',36.3992,25.4793],
  ['KGS','LGKO','Kos','Kos',36.7933,27.0917],
].map(([iata, icao, name, city, lat, lon]) => ({ iata, icao, name, city, lat, lon }));

const byIata = new Map(AIRPORTS.map(a => [a.iata, a]));
export const airportByIata = code => byIata.get((code || '').toUpperCase());

// Altri nomi per la ricerca: città in inglese e in lingua locale, nomi alternativi dell'aeroporto.
// (Il nome italiano della città e il nome dell'aeroporto sono già nella tabella sopra.)
const ALIASES = {
  FCO: 'Rome|Leonardo da Vinci', CIA: 'Rome|Giovan Battista Pastine', MXP: 'Milan', LIN: 'Milan|Forlanini', BGY: 'Milan Bergamo|Il Caravaggio|Orio',
  VCE: 'Venice|Tessera', BLQ: 'Guglielmo Marconi', PSA: 'Galileo Galilei', FLR: 'Florence|Amerigo Vespucci', NAP: 'Naples|Capodichino',
  CTA: 'Vincenzo Bellini|Sicily|Sicilia', PMO: 'Punta Raisi|Sicily|Sicilia', BRI: 'Puglia|Apulia', BDS: 'Salento|Puglia|Apulia', CAG: 'Mario Mameli|Sardinia|Sardegna',
  GOA: 'Genoa|Genua', TRN: 'Turin|Sandro Pertini', LHR: 'London', LGW: 'London', STN: 'London', LTN: 'London', LCY: 'London',
  CDG: 'Paris|Roissy', ORY: 'Paris', BVA: 'Paris|Tillé', LYS: 'Lyon|Lione', AMS: 'Amsterdam', FRA: 'Frankfurt am Main|Frankfurt|Rhein-Main',
  MUC: 'Munich|München|Franz Josef Strauss|Monaco', ZRH: 'Zurich|Zürich|Kloten', VIE: 'Vienna|Wien', MAD: 'Madrid|Adolfo Suárez',
  BCN: 'Barcelona|Josep Tarradellas', LIS: 'Lisbon|Lisboa|Portela', ATH: 'Athens|Athina|Αθήνα', IST: 'Istanbul|İstanbul|Costantinopoli',
  HKG: 'Hong Kong|Chek Lap Kok|香港', DXB: 'Dubai', DOH: 'Doha|Hamad International', JFK: 'New York|John F. Kennedy', EWR: 'New York|Newark',
  BRU: 'Brussels|Brussel|Bruxelles|Zaventem', CPH: 'Copenhagen|København|Kastrup', DUB: 'Dublin|Baile Átha Cliath', TIA: 'Tirana|Nënë Tereza|Madre Teresa',
  MLA: 'Malta|Valletta|La Valletta|Luqa', CAI: 'Cairo|Al Qahira|القاهرة', TLV: 'Tel Aviv|Ben Gurion|Israel', TFS: 'Tenerife South|Reina Sofía|Canarie|Canarias',
  TFN: 'Tenerife North|Los Rodeos|Canarie|Canarias', LPA: 'Gran Canaria|Las Palmas|Canarie|Canarias', ACE: 'Lanzarote|Arrecife|César Manrique|Canarie|Canarias',
  FUE: 'Fuerteventura|Puerto del Rosario|Canarie|Canarias', VLC: 'Valencia|València|Manises', MAN: 'Manchester', EDI: 'Edinburgh|Edimburgo', GLA: 'Glasgow',
  HAM: 'Hamburg|Amburgo|Helmut Schmidt', BER: 'Berlin|Berlino|Willy Brandt', CGN: 'Cologne|Köln|Colonia|Bonn|Konrad Adenauer', STR: 'Stuttgart|Stoccarda|Manfred Rommel',
  FKB: 'Karlsruhe|Baden-Baden|Baden Airpark', MST: 'Maastricht|Aachen|Aquisgrana', BSL: 'Basel|Bâle|Basilea|Mulhouse|Freiburg|Friburgo', BRN: 'Bern|Berne|Berna|Belp',
  SXB: 'Strasbourg|Strasburgo|Entzheim', ARN: 'Stockholm|Stoccolma|Arlanda', HEL: 'Helsinki|Vantaa|Helsingfors', WAW: 'Warsaw|Warszawa|Varsavia|Fryderyk Chopin|Chopin',
  KRK: 'Krakow|Cracow|Kraków|Cracovia|Giovanni Paolo II|John Paul II', PRG: 'Prague|Praha|Praga|Vaclav Havel', BUD: 'Budapest|Ferenc Liszt|Liszt',
  SKG: 'Thessaloniki|Salonicco|Makedonia|Θεσσαλονίκη', HER: 'Heraklion|Iraklio|Candia|Creta|Crete|Nikos Kazantzakis', CHQ: 'Chania|La Canea|Creta|Crete|Daskalogiannis',
  LCA: 'Larnaca|Larnaka|Cipro|Cyprus', PFO: 'Paphos|Pafos|Cipro|Cyprus', ZAG: 'Zagreb|Zagabria|Franjo Tuđman', SPU: 'Split|Spalato', DBV: 'Dubrovnik|Ragusa|Čilipi',
  GVA: 'Geneva|Genève|Genf|Cointrin', FOG: 'Gino Lisa|Puglia', TAR: 'Grottaglie|Marcello Arlotta|Puglia', TRS: 'Ronchi dei Legionari|Friuli Venezia Giulia',
  AOI: 'Falconara|Raffaello Sanzio', PSR: 'Abruzzo', SUF: 'Calabria|Sant\'Eufemia', REG: 'Tito Minniti|Calabria', OLB: 'Costa Smeralda|Sardinia|Sardegna',
  AHO: 'Riviera del Corallo|Fertilia|Sardinia|Sardegna', CUF: 'Levaldigi', PEG: 'San Francesco d\'Assisi|Umbria', RMI: 'Federico Fellini|Miramare',
  RAK: 'Marrakesh|Menara', CMN: 'Casablanca|Dar el Beida|Mohammed V', AGA: 'Agadir|Al Massira', TNG: 'Tangier|Tanger|Ibn Battuta', FEZ: 'Fez|Fès|Saïss',
  RBA: 'Rabat|Salé', TUN: 'Tunis|Tunisi|Carthage|Cartagine', DJE: 'Djerba|Jerba|Zarzis', HRG: 'Hurghada|Al Ghardaqa|Egitto|Egypt', SSH: 'Sharm el Sheikh|Sharm|Egitto|Egypt',
  OSL: 'Oslo|Gardermoen', BGO: 'Bergen|Flesland', GOT: 'Gothenburg|Göteborg|Goteborg|Landvetter', BLL: 'Billund|Legoland', AAL: 'Aalborg|Ålborg',
  KEF: 'Reykjavík|Reykjavik|Keflavík|Islanda|Iceland', RIX: 'Riga|Rīga', TLL: 'Tallinn|Lennart Meri', VNO: 'Vilnius|Vilna',
  SAW: 'Istanbul|İstanbul|Sabiha Gökçen', AYT: 'Antalya', DLM: 'Dalaman', BJV: 'Bodrum|Milas', ADB: 'Izmir|İzmir|Smirne|Adnan Menderes', ESB: 'Ankara|Esenboğa',
  NCE: 'Nice|Nizza|Côte d\'Azur|Costa Azzurra|Monaco|Monte Carlo', MRS: 'Marseille|Marsiglia|Provence|Marignane', TLS: 'Toulouse|Tolosa|Blagnac',
  BOD: 'Bordeaux|Mérignac', NTE: 'Nantes|Atlantique', MLH: 'Mulhouse|Basel|Basilea|Freiburg', OPO: 'Porto|Oporto|Francisco Sá Carneiro', FAO: 'Faro|Algarve|Gago Coutinho',
  FNC: 'Funchal|Madeira|Cristiano Ronaldo', PDL: 'Ponta Delgada|Azores|Açores|Azzorre|João Paulo II', AGP: 'Málaga|Malaga|Costa del Sol', ALC: 'Alicante|Alacant|Elche',
  PMI: 'Palma de Mallorca|Palma|Mallorca|Majorca|Maiorca|Son Sant Joan|Baleari|Balearics', IBZ: 'Ibiza|Eivissa|Baleari|Balearics', MAH: 'Menorca|Minorca|Mahón|Maó|Baleari|Balearics',
  SVQ: 'Seville|Sevilla|Siviglia|San Pablo', BIO: 'Bilbao|Bilbo|Loiu', CRL: 'Brussels South Charleroi|Bruxelles Sud|Charleroi', EIN: 'Eindhoven',
  RTM: 'Rotterdam|The Hague|Den Haag|L\'Aia', LUX: 'Luxembourg|Lëtzebuerg|Luxemburg|Lussemburgo|Findel', DUS: 'Düsseldorf|Dusseldorf', HAJ: 'Hanover|Hannover|Langenhagen',
  NUE: 'Nuremberg|Nürnberg|Norimberga|Albrecht Dürer', LEJ: 'Leipzig|Halle|Lipsia', DRS: 'Dresden|Dresda', BRS: 'Bristol', BHX: 'Birmingham', EMA: 'East Midlands|Nottingham|Derby|Leicester',
  LPL: 'Liverpool|John Lennon', NCL: 'Newcastle', ABZ: 'Aberdeen|Dyce', BFS: 'Belfast|Aldergrove', ORK: 'Cork|Corcaigh', SNN: 'Shannon|Limerick',
  SZG: 'Salzburg|Salisburgo|W. A. Mozart|Mozart', INN: 'Innsbruck|Kranebitten', GRZ: 'Graz|Thalerhof', LNZ: 'Linz|Blue Danube|Hörsching', KTW: 'Katowice|Pyrzowice',
  GDN: 'Gdansk|Gdańsk|Danzica|Lech Wałęsa', WRO: 'Wroclaw|Wrocław|Breslavia|Breslau', POZ: 'Poznan|Poznań|Posen|Ławica', BTS: 'Bratislava|Milan Rastislav Štefánik',
  LJU: 'Ljubljana|Lubiana|Jože Pučnik|Brnik', PUY: 'Pula|Pola|Istria', BEG: 'Belgrade|Beograd|Belgrado|Nikola Tesla', TGD: 'Podgorica|Montenegro',
  SJJ: 'Sarajevo', SKP: 'Skopje|Macedonia', OTP: 'Bucharest|București|Bucarest|Henri Coandă|Otopeni', CLJ: 'Cluj-Napoca|Cluj|Avram Iancu',
  SOF: 'Sofia|София|Vasil Levski', BOJ: 'Burgas|Bourgas', VAR: 'Varna', KIV: 'Chisinau|Kishinev|Chișinău|Moldova', TBS: 'Tbilisi|Tiflis|Shota Rustaveli|Georgia',
  EVN: 'Yerevan|Erevan|Zvartnots|Armenia', RHO: 'Rhodes|Rodos|Rodi|Diagoras', CFU: 'Corfu|Kerkyra|Corfù|Ioannis Kapodistrias', JMK: 'Mykonos|Mikonos|Micono',
  JTR: 'Santorini|Thira|Fira', KGS: 'Kos|Coo|Hippocrates',
};

// Codici di città (più aeroporti): ROM → FCO, CIA ecc.
const CITY_CODES = { ROM: ['FCO', 'CIA'], MIL: ['MXP', 'LIN', 'BGY'], LON: ['LHR', 'LGW', 'STN', 'LTN', 'LCY'], PAR: ['CDG', 'ORY', 'BVA'],
  NYC: ['JFK', 'EWR'], STO: ['ARN'], OSL: ['OSL'], BUH: ['OTP'], IST: ['IST', 'SAW'], TCI: ['TFS', 'TFN'], BER: ['BER'], EAP: ['BSL', 'MLH'] };

/** Minuscolo, senza accenti né punteggiatura: "Zürich" → "zurich", "Sant'Eufemia" → "sant eufemia". */
export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd').replace(/ı/g, 'i').replace(/[æÆ]/g, 'ae')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// per ogni aeroporto: nomi (normalizzati) su cui cercare
const KEYS = new Map(AIRPORTS.map(a => [a.iata, [a.city, a.name, ...(ALIASES[a.iata] || '').split('|')].filter(Boolean).map(norm)]));
const keysOf = a => KEYS.get(a.iata) || [norm(a.city), norm(a.name)];

/** Nomi normalizzati (città e aeroporto in italiano, inglese e lingua locale) di un aeroporto, per i filtri. */
export const airportSearchText = iata => (KEYS.get((iata || '').toUpperCase()) || []).join(' | ');

/** Punteggio di corrispondenza (0 = nessuna). Ogni parola cercata deve comparire, anche parziale. */
function score(a, q, words) {
  const Q = q.replace(/ /g, '').toUpperCase();
  if (a.iata === Q) return 1000;
  if (a.icao === Q) return 900;
  if (CITY_CODES[Q]?.includes(a.iata)) return 800 - CITY_CODES[Q].indexOf(a.iata);
  const keys = keysOf(a);
  let s = 0;
  if (Q.length >= 2 && a.iata.startsWith(Q)) s = 300;
  else if (Q.length >= 2 && a.icao.startsWith(Q)) s = 250;
  for (const k of keys) {
    let t = 0;
    if (k === q) t = 600;
    else if (k.startsWith(q)) t = 500;
    else if ((' ' + k).includes(' ' + q)) t = 400;
    else if (words.every(w => (' ' + k).includes(' ' + w))) t = 350;
    else if (q.length >= 3 && k.includes(q)) t = 200;
    if (t > s) s = t;
  }
  if (!s && words.length > 1) {
    // parole sparse tra città e nome (es. "londra gatwick", "milan bergamo")
    const all = ' ' + keys.join(' ');
    if (words.every(w => all.includes(' ' + w))) s = 300;
  }
  if (s && keys[0].startsWith(q)) s += 20; // la città prima del resto
  return s;
}

export function searchAirports(q, limit = 8) {
  q = norm(q);
  if (!q) return [];
  const words = q.split(' ');
  return AIRPORTS.map((a, i) => ({ a, s: score(a, q, words), i }))
    .filter(x => x.s > 0).sort((x, y) => y.s - x.s || x.i - y.i).slice(0, limit).map(x => x.a);
}

/** Codice IATA dal nome di una città (qualunque lingua), solo se univoco. */
export function iataByCityName(city) {
  const c = norm(city);
  if (!c) return null;
  const main = AIRPORTS.filter(a => keysOf(a)[0] === c || keysOf(a)[1] === c); // città o nome dell'aeroporto
  if (main.length) return main.length === 1 ? main[0].iata : null;
  const hits = AIRPORTS.filter(a => keysOf(a).includes(c)); // altri nomi
  return hits.length === 1 ? hits[0].iata : null;
}
