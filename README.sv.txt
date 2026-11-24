Betalar du effektavgift till ditt elnätsbolag? Med Capacity limit håller PELS timmens medeleffekt under din gräns genom att sänka laddströmmen, justera värmen och pausa de minst prioriterade enheterna. När mer effekt finns tillgänglig höjs laddströmmen och pausade enheter startas igen. Grid import limit gäller effekten du tar från elnätet just nu, och gränserna kan användas var för sig eller tillsammans.

PELS flyttar elbilsladdning och uppvärmning till billigare tider med hjälp av enheternas Homey-appar. PELS kan bland annat styra laddboxar från Easee, Zaptec, Alfen, Peblar, Wallbox och Zappi, värmepumpar, termostater och varmvattenberedare. Du väljer temperaturer och vilka enheter som ska prioriteras.

Slutför konfigurationen under Homey > Mer > Appar > PELS > Inställningar. Ett smart uttag kan mäta hur mycket effekt en kompatibel enhet drar om den saknar egen mätning, och om enheten har en separat strömbrytare för värmen kan du välja att PELS använder den.

Elpriserna kommer från Homey Energy, Power by the Hour eller dina Flows. PELS räknar med tidsberoende nätavgifter som ingår i priset. Värme och kyla kan också följa kvartspriser.

Med Smart tasks kan du till exempel ställa in att bilen ska vara laddad till 80 % kl. 07.00 eller att vardagsrummet ska vara varmt när du kommer hem. Du kan också ange hur mycket energi varmvattenberedaren ska få. PELS föredrar tider med lägre pris då det finns effekt tillgänglig och använder bilens batterinivå om den finns i Homey. Med Schedules kan du skapa Smart tasks eller byta läge vid bestämda tider, en gång eller på valda dagar. PELS kan börja värma i förväg inför ett lägesbyte du har schemalagt.

PELS använder solöverskott till varmvatten, uppvärmning, kyla och billaddning och anpassar laddströmmen efter produktionen. Priset för såld el ingår också i planeringen, även när det är negativt. Ett hembatteri, till exempel Sessy, Marstek Venus, Zendure, Huawei LUNA2000, Sigenergy eller Anker SOLIX, kan lagra överskottet och leverera effekt när hushållet närmar sig din gräns. PELS begränsar också batteriets laddning när en enhet med högre prioritet behöver effekten. Om du slår på det kan PELS också sälja lagrad el när det sänker dina kostnader.

Lägen som Home, Away och Night har egna temperaturer och prioriteringar och kan växlas med Flows. Smart tasks kan också startas direkt från Homey-dashboarden.

Simulation mode visar hur PELS skulle styra enheterna tills du väljer Start managing i slutet av konfigurationen.
