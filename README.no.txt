PELS reduserer effekttoppene ved å senke ladestrømmen, justere varmen eller pause enheter med lavere prioritet. Ladestrømmen økes og enhetene starter igjen når det er ledig effekt. Appen styrer blant annet Easee- og Zaptec-ladere, varmtvannsberedere, panelovner, varmepumper og hjemmebatterier gjennom styringsfunksjonene enhetenes Homey-apper tilbyr. Du velger hvilke enheter som skal få strøm først, også når utstyret kommer fra ulike produsenter.

Etter installasjonen åpner du Homey > Mer > Apper > PELS > Innstillinger for å fullføre oppsettet. Her velger du enheter, setter opp PELS og ser hva appen gjør.

Med Capacity limit setter du en grense for gjennomsnittlig effekt per time, så du holder deg på et lavere effekttrinn i nettleien. De siste ti minuttene av timen trapper PELS ned forbruket, så neste time ikke starter over grensen. Grid import limit gjelder effekten du henter fra nettet her og nå. Grensene kan brukes hver for seg eller sammen. Målingene kommer fra Homey Energy, en HAN-leser eller en Flow. Hytta eller sokkelleiligheten kan ha egen måler og effektgrense. Med Norgespris eller fast strømpris holder effektstyringen deg fortsatt på et lavere effekttrinn.

Med Smart tasks kan bilen være ladet til 80 % innen klokka 07, stua varm ved hjemkomst eller varmtvannsberederen ha fått en bestemt energimengde. PELS velger de billigste timene fram til fristen. Når batterinivået er tilgjengelig i Homey, bruker PELS det i ladeplanen. Temperaturstyringen tar også hensyn til kvarterpriser.

Med priskilden Norway (spot + grid tariff) regner PELS ut strømprisen med nettleien fra nettselskapet ditt og strømstøtte eller Norgespris. Du kan også bruke priser fra Homey Energy, Power by the Hour eller Flows. Tidsavhengige priser og nettleie som er lagt inn i den valgte priskilden, tas med i planleggingen. I et Enova-støttet anlegg kan PELS stå for pris- og effektstyringen.

Har du solceller eller hjemmebatteri, bruker PELS soloverskuddet til varmtvann, oppvarming og elbillading, og batteriet til å holde forbruket under effektgrensen.

Moduser som Home, Away og Night har egne temperaturer og prioriteringer. Flows kan bytte modus når du drar hjemmefra eller legger deg.

Simulation mode viser hvordan PELS ville styrt enhetene, helt til du velger Start managing til slutt i oppsettet.
