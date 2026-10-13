PELS programme la recharge de votre voiture, le chauffage et l'eau chaude en fonction des prix de l'électricité. Il s'appuie sur les commandes des applications Homey pour piloter notamment les bornes Easee et Zaptec, les pompes à chaleur, les thermostats et les chauffe-eau. Les appareils peuvent être de marques différentes ; vous choisissez leurs priorités.

Les prix proviennent de Homey Energy, de Power by the Hour ou de vos Flows. Les heures pleines, les heures creuses et les frais de réseau renseignés dans la source choisie entrent dans la planification. PELS ajuste aussi le chauffage et la climatisation selon les prix au quart d'heure.

Dans Smart tasks, vous fixez un objectif et une échéance : une voiture à 80 % à 7 h, un salon chaud pour votre retour ou une quantité d'énergie à fournir au chauffe-eau. PELS choisit les heures les moins chères pour y parvenir. Quand le niveau de batterie est disponible dans Homey, PELS s'en sert pour planifier la recharge jusqu'à l'objectif demandé.

Avec Grid import limit, vous réglez la limite de puissance prélevée sur le réseau selon votre abonnement et les besoins de la maison. À son approche, PELS réduit la recharge, ajuste le chauffage ou met les appareils moins prioritaires en pause. Ils reprennent lorsque de la puissance est disponible.

Avec des panneaux solaires, le surplus sert à chauffer l'eau, préchauffer ou rafraîchir la maison et recharger la voiture. PELS adapte la puissance de recharge au surplus disponible. Le prix de vente au réseau est pris en compte, y compris s'il est négatif. Avec une batterie domestique comme Sessy ou Marstek Venus, PELS stocke le surplus restant, réduit sa recharge au profit d'un autre appareil ou la décharge pour respecter la limite de puissance.

Home, Away et Night définissent les températures et les priorités pour chaque situation.

La configuration guidée est accessible dans Homey > Plus > Apps > PELS > Paramètres. Simulation mode permet de voir les décisions de PELS avant d'activer le pilotage automatique.
