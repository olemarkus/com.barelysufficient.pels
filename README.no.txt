PELS reduserer effekttoppene ved å senke ladestrømmen, justere varmen eller pause enheter med lavere prioritet. Enhetene starter igjen når det er ledig effekt. PELS kan styre varmtvannsberedere, panelovner, varmepumper, hjemmebatterier og ladere fra blant andre Easee, Zaptec, Alfen, Peblar, Wallbox og Zappi. Du velger hvilke enheter som skal få strøm først.

Etter installasjonen åpner du Homey > Mer > Apper > PELS > Innstillinger og velger Devices under Set up PELS på oversikten. Velg en av enhetene du allerede har i Homey. PELS Insights er valgfri og viser status i Homey. For enheter PELS støtter, kan du måle effekten med en smartplugg hvis enheten ikke måler selv. Har enheten en egen bryter for varmen, kan du velge at PELS bruker den. Oppsett på norsk: https://pels.barelysufficient.org/stromstyring-norge.html

Med Capacity limit setter du en grense for gjennomsnittlig effekt per time for å holde deg på et lavere effekttrinn i nettleien. Når du har satt opp norsk nettleie i PELS, får du et anslag på månedens effekttrinn og et forslag til grense for resten av måneden. Grid import limit gjelder effekten du henter fra nettet her og nå. Målingene kommer fra Homey Energy, en HAN-leser eller en Flow. Hytta eller sokkelleiligheten kan ha egen måler og effektgrense. Effektstyring kan også hjelpe deg å holde et lavere effekttrinn med Norgespris eller fast strømpris.

Med Smart tasks kan du for eksempel sette som mål at bilen skal være ladet til 80 % klokka 07, eller at stua skal være varm når du kommer hjem. PELS foretrekker rimeligere tider der det er nok ledig effekt, og bruker bilens batterinivå når det er tilgjengelig i Homey. Temperaturstyringen tar også hensyn til kvarterpriser. Med Schedules kan du planlegge når Smart tasks skal opprettes eller modusen skal byttes. PELS kan begynne å varme opp før et planlagt modusbytte.

Med priskilden Norway (spot + grid tariff) regner PELS ut strømprisen med nettleien fra nettselskapet ditt og strømstøtte eller Norgespris. Du kan også bruke priser fra Homey Energy, Power by the Hour eller Flows. Tidsavhengige priser og nettleie som er lagt inn i den valgte priskilden, tas med i planleggingen. I et Enova-støttet anlegg kan PELS stå for pris- og effektstyringen.

Har du solceller, bruker PELS overskuddet til varmtvann, oppvarming og elbillading. Har du et hjemmebatteri, bruker PELS det til å holde effekten du trekker fra nettet under grensen. PELS styrer blant annet hjemmebatterier som Sessy, Marstek Venus, Zendure, Huawei LUNA2000, Sigenergy og Anker SOLIX.

Moduser som Home, Away og Night har egne temperaturer og prioriteringer. Flows kan bytte modus når du drar hjemmefra eller legger deg.

Simulation mode viser hvordan PELS ville styrt enhetene, helt til du velger Start managing til slutt i oppsettet.
