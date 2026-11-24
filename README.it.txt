Il forno è acceso, l'auto è in carica e serve acqua calda. PELS regola ricarica, riscaldamento e scaldacqua in base ai consumi di casa, dando precedenza agli apparecchi che scegli tu. La ricarica rallenta quando accendi il forno e riprende automaticamente quando c'è più potenza disponibile. I comandi delle app Homey permettono a PELS di gestire apparecchi di marche diverse, come le wallbox Easee, Zaptec, Alfen, Peblar, Wallbox e Zappi.

Dopo l’installazione, apri Homey > Altro > App > PELS > Impostazioni per completare la configurazione.

Per un apparecchio compatibile senza misurazione integrata puoi usare una presa smart che ne misuri la potenza. Se l’apparecchio ha un interruttore dedicato al riscaldamento, puoi scegliere quello per controllarlo.

Con Grid import limit imposti la potenza da prelevare dalla rete in base alle esigenze della casa e al tuo contratto. PELS segue il consumo totale misurato da Homey Energy, da un lettore del contatore o da un Flow, tenendo conto del fotovoltaico. Se necessario, mette in pausa gli apparecchi meno prioritari.

Per programmare ricarica, riscaldamento e acqua calda, PELS usa i prezzi di Power by the Hour o dei tuoi Flow. Le tariffe orarie e i costi di rete impostati nella fonte scelta vengono inclusi nella pianificazione. Per riscaldamento e raffrescamento, PELS tiene conto anche dei prezzi aggiornati ogni 15 minuti.

In Smart tasks indichi l'obiettivo e quando deve essere raggiunto: l'auto all'80 % alle 7, il soggiorno caldo al rientro o quanta energia fornire allo scaldacqua entro il mattino. PELS privilegia le fasce meno costose in base alla potenza disponibile. Se Homey fornisce il livello di carica dell’auto, PELS lo usa per pianificare la ricarica. Con Schedules puoi creare Smart tasks o cambiare modalità a orari prestabiliti, una volta o nei giorni scelti. PELS può avviare il riscaldamento prima di un cambio di modalità programmato.

Quando i pannelli producono più di quanto la casa consuma, il surplus viene usato per l'acqua calda, il riscaldamento, il raffrescamento o la ricarica dell'auto. La potenza di ricarica si adatta al surplus disponibile. Anche il prezzo dell'energia immessa in rete, compresi i valori negativi, rientra nella pianificazione. PELS distribuisce il surplus tra gli apparecchi e la batteria domestica secondo le tue priorità. Può anche usare l’energia accumulata per rispettare il limite di potenza. Tra le batterie compatibili ci sono Sessy, Marstek Venus, Zendure, Huawei LUNA2000, Sigenergy e Anker SOLIX. Se lo attivi, PELS può anche vendere l'energia accumulata quando questo riduce i tuoi costi.

Modalità come Home, Away o Night definiscono temperature e priorità per le diverse abitudini di casa.

Simulation mode mostra in anteprima come verrebbero gestiti gli apparecchi, finché non scegli Start managing alla fine della configurazione.
