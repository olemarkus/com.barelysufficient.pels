PELS reduserer effekttoppene ved å senke ladestrømmen, justere varmen eller pause enheter med lavere prioritet. Ladestrømmen økes og enhetene starter igjen når det er ledig effekt. Appen styrer blant annet Easee- og Zaptec-ladere, varmtvannsberedere, panelovner, varmepumper og hjemmebatterier gjennom styringsfunksjonene enhetenes Homey-apper tilbyr. Du velger hvilke enheter som skal få strøm først, også når utstyret kommer fra ulike produsenter.

Med Capacity limit setter du en grense for gjennomsnittlig effekt per time eller kvarter for å holde nettleien nede. Grid import limit gjelder effekten du henter fra nettet her og nå. Grensene kan brukes hver for seg eller sammen. Målingene kommer fra Homey Energy, en HAN-leser eller en Flow. Hytta eller sokkelleiligheten kan ha egen måler og effektgrense. Effektstyringen er like nyttig med fast strømpris.

Med Smart tasks kan bilen være ladet til 80 % innen klokka 07, stua varm ved hjemkomst eller varmtvannsberederen ha fått en bestemt energimengde. PELS velger de billigste timene fram til fristen. Når batterinivået er tilgjengelig i Homey, bruker PELS det i ladeplanen. Temperaturstyringen tar også hensyn til kvarterpriser.

PELS beregner norsk spotpris med nettleie og strømstøtte, eller bruker priser fra Homey Energy, Power by the Hour eller Flows. Tidsavhengige priser og nettleie som er lagt inn i den valgte priskilden, tas med i planleggingen. I et Enova-støttet anlegg kan PELS stå for pris- og effektstyringen.

Soloverskudd kan brukes til varmtvann, oppvarming og elbillading. PELS tilpasser ladestrømmen til produksjonen. Et hjemmebatteri som Sessy eller Marstek Venus kan lagre overskuddet som de andre enhetene ikke bruker. PELS reduserer batteriladingen når enheter med høyere prioritet trenger effekt, og bruker batteriet til å holde forbruket under effektgrensen.

Home, Away og Night har egne temperaturer og prioriteringer. Flows kan bytte modus når du drar hjemmefra eller legger deg.

Det veiledede oppsettet ligger under Homey > Mer > Apper > PELS > Innstillinger. Simulation mode viser hvordan PELS ville styrt enhetene før du slår på automatisk styring.
