---
title: PELS for norske hjem
description: Oversikt over PELS for Homey Pro, strømstyring, kapasitetsledd, elbillading, varmtvannsbereder, varme, spotpris, nettleie, strømstøtte, Norgespris og Enova.
---

# PELS for norske hjem

Utformingen av strømkostnadene og de ulike støtteordningene gjør PELS spesielt relevant for norske hjem. Spesielt kapasitetsleddet i nettleien er det nesten umulig å håndtere uten et automatisert styringssystem. PELS er nettopp hjernen i et slikt system, og den styrer etter både kapasitetsledd og pris. Det er mye man kan gjøre for å sørge for at strømforbruket i hovedsak skjer når strømprisen er lav.

Enova har en støtteordning for pris- og effektstyrt energilagringssystem i boliger. PELS er relevant for styringsdelen fordi appen kan styre fleksibelt strømforbruk etter pris, effektgrense og prioritet i Homey. Se mer hos [Enovas side om pris- og effektstyrt energilagringssystem](https://enova.no/nb/privat/bolig/stotte/pris-og-effektstyrt-energilagringssystem/).

PELS alene garanterer ikke støtte. Enova vurderer tiltak etter gjeldende vilkår, dokumentasjon og installasjon. Hvis støtte er viktig for deg, må du lese Enovas krav før du kjøper utstyr eller gjør installasjon.

## Hva PELS gjør

PELS trenger en løpende måling av hele boligens effektforbruk. Som regel kommer dette fra en HAN-sensor koblet i strømmåleren. Når dette er på plass, kan du sette opp hvilket kapasitetstrinn du ønsker å holde deg på, og deretter vil PELS sørge for at du holder deg under.

Når PELS ser at boligen nærmer seg grensen du har satt, reduseres de minst viktige enhetene først. Slik kan appen holde igjen fleksibelt forbruk uten at du må lage egne regler for hver situasjon.

PELS kan også styre etter strømpriser. PELS kombinerer spotpris, nettleie, avgifter, leverandørpåslag og valgt ordning for strømstøtte eller Norgespris i én timepris. Alt etter hva man ønsker, kan PELS øke temperatur i billige timer, senke temperatur i dyre timer, sørge for at varmtvann og elbillading kun skjer når strømmen er billig. Se [Kostnadsbesparende funksjoner](/cost-saving-functions) for de ulike mulighetene PELS tilbyr.

## Når PELS passer

PELS passer best når noe av det store strømforbruket i boligen kan vente litt eller kjøres med lavere effekt:

- elbillading
- varmtvannsbereder
- gulvvarme
- panelovn
- ventilasjon eller andre enheter med høy effekt

Appen er særlig nyttig når høyt samtidig forbruk kan gi et dyrere kapasitetstrinn, eller når du vil holde god avstand til en sikringsgrense. Den passer også når du vil bruke billigere timer uten å bygge mange egne Flows.

## Hva du trenger

Du trenger:

1. Homey Pro.
2. PELS installert fra Homey App Store.
3. En HAN-sensor koblet opp mot Homey.
4. En eller flere enheter Homey kan styre, for eksempel lader, termostat, av/på-bryter eller enhet med trinnvis effekt.

Begynn enkelt. Koble til totalforbruket, velg en realistisk grense og la PELS styre én eller to tydelige enheter først. Legg heller til mer styring når du ser at grunnoppsettet fungerer.

## Effektledd, kapasitetsledd og effektgrense

I PELS setter du grensen som **Hard cap (kW)**. Det er den øvre grensen PELS prøver å holde boligen under. Hvis du for eksempel setter grensen til 5 kW, begynner PELS å begrense fleksibelt forbruk før timesnittet blir for høyt.

To innstillinger er sentrale:

- **Hard cap (kW)**: den øvre grensen PELS prøver å holde boligen under.
- **Safety margin (kW)**: sikkerhetsmarginen under grensen, slik at PELS rekker å reagere før timen kan telle mot et høyere kapasitetstrinn eller sikringen belastes for hardt.

## Elbillading

Elbillading er ofte det mest fleksible forbruket i boligen. Derfor er det også et godt sted å starte. Med PELS kan laderen settes opp til å bruke mindre strøm, eller pauses, når huset nærmer seg grensen du har satt.

For ladere med strømkontroll beregner PELS ønsket ladestrøm i ampere. En Homey Flow sender verdien fra PELS videre til laderappen. Hvis bilen skal nå et bestemt ladenivå før et klokkeslett, for eksempel 80 % før 07:00, kan du bruke Smart tasks i stedet for fast prisstyring.

Vanlig oppsett:

- slå på **Managed** for laderen
- velg **EV 1-phase** eller **EV 3-phase** etter hvordan laderen er installert
- send ønsket ladestrøm fra PELS til laderappen med Flow
- bruk Smart tasks når bilen skal være klar til et bestemt tidspunkt

Se [Konfigurer elbillader](/ev-charger) for selve oppsettet. Se også [Homey EV charging without crossing your power limit](/use-cases/homey-ev-charging-power-limit) for et mer konkret bruksområde.

## Varmtvannsbereder

Varmtvannsberedere, gulvvarme og panelovner kan slås av i kortere pauser uten at det påvirker temperaturen eller komforten.

For eksempel kan PELS holde igjen strømforbruket til en varmtvannsbereder i den perioden du lager middag med en induksjonsplatetopp, og la berederen kjøre igjen etterpå. Om du også kun trenger varmtvann på gitte tidspunkt kan PELS sørge for at vannet er oppvarmet til da, og at oppvarmingen skjer i de billigst mulige timene.

## Gulvvarme og panelovn

Gulvvarme passer ofte godt med prisstyring fordi gulvet lagrer varme. PELS kan heve måltemperaturen i billige timer og senke den i dyre timer. Panelovner reagerer raskere og lagrer mindre varme, så de bør normalt styres mer forsiktig.

## Praktisk startpunkt

- gi viktige rom høyere prioritet
- la mindre viktige soner eller varmtvannsbereder begrenses først
- bruk moderate temperaturendringer for prisstyring
- test med **Simulation mode** før PELS får reell kontroll

> **Sikkerhet:** Ikke styr varmtvannsbereder, gulvvarme eller faste elektriske laster med utstyr som ikke er beregnet for belastningen. Fast elektrisk arbeid skal utføres av fagfolk. Husk også temperatur-, hygiene- og sikkerhetskrav for varmtvann; PELS skal planlegge lasten, ikke erstatte trygg varmtvannskontroll.

## Spotpris, nettleie, strømstøtte og Norgespris

PELS kan bruke flere priskilder. I Norge er den innebygde kilden laget for norske strømpriser og kan kombinere spotpris, nettleie, leverandørpåslag, avgifter og valgt ordning for strømstøtte eller Norgespris. Du velger dette i innstillingene.

## Gå videre

- [Kom i gang](/getting-started): installer PELS, koble til måler og sett første effektgrense.
- [Konfigurasjon](/configuration): full oversikt over innstillingene.
- [Konfigurer elbillader](/ev-charger): koble elbillader til PELS med strømkontroll.
- [Smart tasks](/smart-tasks): lad bil, varm rom eller klargjør varmtvann til et bestemt tidspunkt.
- [Kostnadsbesparende funksjoner](/cost-saving-functions): sammenlign effektstyring, daglig budsjett, prisstyring, Smart tasks og billige timer valgt med Flow.
