Elbilsladdning och uppvärmning står ofta för en stor del av elräkningen. PELS använder styrfunktionerna i enheternas Homey-appar för att flytta laddning och uppvärmning till billigare timmar. Appen kan bland annat styra laddboxar från Easee och Zaptec, värmepumpar, termostater och varmvattenberedare. Du väljer temperaturer och vilka enheter som ska prioriteras. Appen kan styra utrustning från olika tillverkare.

Elpriserna kommer från Homey Energy, Power by the Hour eller dina Flows. När tidsberoende nätavgifter ingår i den valda priskällan tar PELS med dem i planeringen. Temperaturstyrningen kan även följa kvartspriser och anpassa både värme och kyla.

Med Smart tasks kan målet vara 80 % i bilbatteriet klockan 07, ett varmt vardagsrum när du kommer hem eller en viss mängd energi till varmvattenberedaren. PELS väljer de billigaste timmarna fram till sluttiden. PELS kan också använda batterinivån i laddplanen när den finns i Homey.

Capacity limit hjälper till att hålla nere effekttopparna om du betalar effektavgift. Grid import limit gäller effekten du tar från elnätet just nu. Gränserna kan användas var för sig eller tillsammans. PELS följer hela hemmets förbrukning, sänker laddströmmen, justerar värmen och pausar de minst prioriterade enheterna. När mer effekt finns tillgänglig höjs laddströmmen och pausade enheter startas igen.

PELS använder solöverskott till varmvatten, uppvärmning, kyla och billaddning och anpassar laddströmmen efter produktionen. Priset för såld el ingår också i planeringen, även när det är negativt. Ett hembatteri, till exempel Sessy eller Marstek Venus, kan lagra överskottet och leverera effekt när hushållet närmar sig din gräns. PELS begränsar också batteriets laddning när andra enheter behöver effekten.

Home, Away och Night har egna temperaturer och prioriteringar och kan växlas med Flows. Smart tasks kan också startas direkt från Homey-dashboarden.

Den guidade konfigurationen finns under Homey > Mer > Appar > PELS > Inställningar. Simulation mode visar hur PELS skulle styra enheterna innan du slår på automatisk styrning.
