Il forno è acceso, l'auto è in carica e serve acqua calda. PELS regola ricarica, riscaldamento e scaldacqua in base ai consumi di casa, dando precedenza agli apparecchi che scegli tu. La ricarica rallenta quando accendi il forno e riprende automaticamente quando c'è più potenza disponibile. Da Homey puoi gestire anche apparecchi di marche diverse, come le wallbox Easee e Zaptec.

Con Grid import limit imposti la potenza da prelevare dalla rete in base alle esigenze della casa e al tuo contratto. PELS segue il consumo totale misurato da Homey Energy, da un lettore del contatore o da un Flow, tenendo conto del fotovoltaico. Se necessario, mette in pausa gli apparecchi meno prioritari. Capacity limit gestisce invece i picchi di potenza media calcolati su un'ora o su 15 minuti. Le due funzioni si usano separatamente o insieme.

PELS programma ricarica, riscaldamento e acqua calda nelle fasce orarie più convenienti. I prezzi arrivano da Homey Energy, Power by the Hour o dai tuoi Flow. Le tariffe orarie e i costi di rete impostati nella fonte scelta vengono inclusi nella pianificazione. Per riscaldamento e raffrescamento, PELS tiene conto anche dei prezzi aggiornati ogni 15 minuti.

In Smart tasks indichi l'obiettivo e quando deve essere raggiunto: l'auto all'80 % alle 7, il soggiorno caldo al rientro o quanta energia fornire allo scaldacqua entro il mattino. PELS sceglie le ore meno costose e legge direttamente il livello della batteria delle auto associate alla wallbox.

Quando i pannelli producono più di quanto la casa consuma, il surplus viene usato per l'acqua calda, il riscaldamento, il raffrescamento o la ricarica dell'auto. La potenza di ricarica si adatta al surplus disponibile. Anche il prezzo dell'energia immessa in rete, compresi i valori negativi, rientra nella pianificazione. Con una batteria domestica come Sessy o Marstek Venus, PELS accumula il surplus rimasto, limita la carica quando altri apparecchi hanno la precedenza e usa l'energia accumulata per rispettare il limite di potenza.

Home, Away e Night definiscono temperature e priorità per le diverse abitudini di casa. Daily budget distribuisce i consumi nella giornata; PELS impara come il meteo influisce sui consumi. Dai widget Homey puoi controllare potenza disponibile, budget e Smart tasks e avviare una nuova attività.

Simulation mode mostra in anteprima come verrebbero gestiti gli apparecchi. La configurazione guidata si trova in Homey > Altro > App > PELS > Impostazioni.
