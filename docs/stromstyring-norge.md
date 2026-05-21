---
title: PELS for norske hjem
description: Norsk oversikt over PELS for Homey Pro, effektgrense, kapasitetsledd, elbillading, varmtvannsbereder, varme, spotpris, nettleie, strømstøtte, Norgespris og Enova.
---

# PELS for norske hjem

Denne siden er skrevet for deg som søker etter strømstyring, effektledd, kapasitetsledd, elbillading eller billigere strøm i et norsk Homey Pro-hjem.

PELS er en Homey-app som følger strømforbruket i hele boligen og styrer fleksible laster som elbillader, varmtvannsbereder, gulvvarme og panelovner. Målet er å holde deg under en valgt effektgrense, bruke billigere timer når det passer, og samtidig la viktige enheter få prioritet.

## Hva PELS gjør

PELS leser løpende effektforbruk fra Homey Energy, en AMS/HAN/P1-måler, Tibber Pulse eller en Homey Flow. Når forbruket nærmer seg grensen du har valgt, kan PELS senke, pause eller slå av lavere prioriterte enheter først. Når det er nok tilgjengelig effekt igjen, starter PELS dem i prioritert rekkefølge.

PELS kan også bruke strømpriser. I Norge kan appen kombinere spotpris, nettleie, avgifter og valgt prisordning i én timepris. Den prisen brukes blant annet til å flytte fleksibelt forbruk mot billigere timer, planlegge Smart tasks og gi varmeenheter lavere eller høyere måltemperatur gjennom døgnet.

## Når PELS passer

PELS passer best når du har en eller flere store laster som kan vente litt uten at hverdagen blir dårligere:

- elbillader
- varmtvannsbereder
- gulvvarme
- panelovn
- ventilasjon eller andre enheter med høy effekt

Det er spesielt nyttig hvis en enkelt time med høyt forbruk kan gi et dyrere kapasitetsledd, eller hvis du vil unngå å ligge nær en sikringsgrense. PELS passer også godt når du vil bruke billigere timer uten å bygge mange egne Flows for hver enhet.

PELS passer dårligere hvis alt stort forbruk må kjøre med full effekt akkurat når det startes. Appen trenger fleksibilitet for å kunne flytte eller begrense last.

## Hva du trenger

Du trenger:

1. Homey Pro.
2. PELS installert fra Homey App Store.
3. En kilde til totalforbruk i watt, for eksempel Homey Energy, Tibber Pulse, AMS/HAN/P1-måler, Shelly EM eller en Flow som rapporterer effekt.
4. En eller flere enheter Homey kan styre, for eksempel lader, termostat, av/på-bryter eller enhet med trinnvis effekt.
5. En effektgrense du ønsker å holde deg under, typisk valgt fra nettleieavtalen, kapasitetsleddet eller sikringsgrensen din.

Start med totalforbruk og én eller to tydelige laster. Legg heller til mer styring når du ser at grunnoppsettet fungerer.

## Effektledd, kapasitetsledd og effektgrense

Mange søker etter "effektledd" når de egentlig mener at strømregningen påvirkes av den høyeste timen eller de høyeste timene i måneden. For husholdninger omtaler mange nettselskap dette som kapasitetsledd, kapasitetstrinn eller et trinn i fastleddet.

I PELS setter du dette som **Hard cap (kW)**. Det er effektgrensen PELS prøver å holde boligen under. Setter du for eksempel grensen til 5 kW, vil PELS begynne å begrense fleksible laster før snittet for timen risikerer å bli for høyt.

To innstillinger er viktige:

- **Hard cap (kW)**: grensen du ikke vil overstige.
- **Safety margin (kW)**: en buffer under grensen, slik at PELS rekker å reagere før timen blir dyrere eller sikringen belastes for hardt.

PELS kan ikke endre hvordan nettselskapet beregner nettleien din. Det appen kan gjøre, er å redusere risikoen for at fleksibelt forbruk skyver deg inn i et dyrere trinn.

## Elbillading

Elbillading er ofte den største og mest fleksible lasten i boligen. Med PELS kan en lader være en vanlig managed enhet, slik at den får mindre effekt eller pauses når huset nærmer seg effektgrensen.

For ladere med strømkontroll kan PELS beregne ønsket ladestrøm i ampere. Da lager du en Flow som sender PELS sin verdi videre til laderappen. PELS kan også bruke Smart tasks når bilen skal ha en bestemt batteriprosent innen et klokkeslett, for eksempel 80 % før 07:00.

Vanlig oppsett:

- legg laderen inn som managed
- velg EV 1-phase eller EV 3-phase etter installasjonen
- la PELS sende ønsket ladestrøm til laderappen med Flow
- bruk Smart tasks hvis bilen skal være klar til et bestemt tidspunkt

Se [Konfigurer elbillader](/ev-charger) for oppsettet.

## Varmtvannsbereder, gulvvarme og panelovn

Varmtvannsbereder, gulvvarme og panelovner er gode kandidater fordi de ofte tåler korte pauser eller små temperaturendringer.

For varmtvannsbereder kan PELS slå av eller senke effekten mens annet viktig forbruk pågår, og la berederen starte igjen når det er tilgjengelig effekt. Hvis varmtvann må være klart før et kjent tidspunkt, kan en Smart task være bedre enn enkel prisstyring.

Gulvvarme passer ofte godt med prisstyring fordi gulvet lagrer varme. PELS kan heve målet i billige timer og senke det i dyre timer. Panelovner reagerer raskere og har mindre lagring, så de bør ofte styres mer forsiktig for å unngå merkbare komfortendringer.

Praktisk startpunkt:

- gi rom med viktig komfort høyere prioritet
- la mindre viktige soner eller varmtvannsbereder begrenses først
- bruk moderate temperaturendringer for prisstyring
- test med Simulation mode før PELS får reell kontroll

## Spotpris, nettleie, strømstøtte og Norgespris

PELS kan bruke forskjellige priskilder. I Norge er den innebygde kilden laget for norske strømpriser og kan kombinere spotpris, nettleie, leverandørpåslag, avgifter og valgt prisordning. Du kan velge mellom strømstøtte og Norgespris-modellen i innstillingene.

Dette er viktig: PELS er ikke en fasit for strømregningen din. Faktisk regning avhenger av strømavtale, nettselskap, måledata, prisområde, offentlige regler og hvordan strømstøtte eller Norgespris gjelder for deg. Bruk PELS-prisen som et styringsgrunnlag for automasjon, og sjekk alltid avtale og regelverk hos strømleverandør, nettselskap og offentlige kilder.

Hvis Homey Energy allerede gir deg en komplett pris du stoler på, kan PELS også bruke Homey Energy som priskilde.

## Enova: relevant styringsdel, men ingen garanti for støtte

Enova har hatt støtteordninger for pris- og effektstyrt energilagringssystem i boliger. PELS er relevant for styringsdelen fordi appen kan styre fleksibelt strømforbruk etter pris, effektgrense og prioritet i Homey.

Det betyr ikke at PELS alene garanterer støtte. Enova vurderer tiltak etter gjeldende vilkår, dokumentasjon og installasjon. Hvis støtte er viktig for deg, må du lese Enovas krav før du kjøper utstyr eller gjør installasjon, og du bør dokumentere hvilke enheter som styres og hvordan styringen fungerer.

## Gå videre

- [Kom i gang](/getting-started): installer PELS, koble til måler og sett første effektgrense.
- [Konfigurasjon](/configuration): full oversikt over innstillingene.
- [Konfigurer elbillader](/ev-charger): koble elbillader til PELS med strømkontroll.
- [Smart Tasks](/smart-tasks): lad bil, varm rom eller klargjør varmtvann innen et tidspunkt.
- [Kostnadsbesparende funksjoner](/cost-saving-functions): sammenlign effektstyring, daglig budsjett, prisstyring, Smart tasks og Flow-baserte billige timer.

## Kilder og videre lesing

- [NVE/RME om nettleie for forbruk](https://www.nve.no/reguleringsmyndigheten/regulering/nettvirksomhet/nettleie/nettleie-for-forbruk/)
- [RME om nettselskapenes nettleiemodeller](https://www.nve.no/reguleringsmyndigheten/nytt-fra-rme/nyheter-reguleringsmyndigheten-for-energi/rme-har-kartlagt-nettselskapenes-valg-av-nettleiemodeller/)
- [Regjeringen om strømstøtte og Norgespris](https://www.regjeringen.no/no/tema/energi/strom/regjeringens-stromtiltak/id2900232/)
- [Enova om pris- og effektstyrt energilagringssystem](https://enova.no/nb/privat/bolig/stotte/pris-og-effektstyrt-energilagringssystem/)
