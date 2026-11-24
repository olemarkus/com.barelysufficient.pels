PELS pilote le chauffage électrique, le chauffe-eau et la recharge de votre voiture selon vos tarifs et la puissance disponible. Il s'appuie sur les commandes des applications Homey, notamment pour les bornes Easee, Zaptec, Alfen, Peblar, Wallbox et Zappi, les pompes à chaleur, les thermostats et les chauffe-eau. Vous choisissez les priorités de vos appareils.

Après l’installation, ouvrez Homey > Plus > Apps > PELS > Paramètres pour terminer la configuration.

Pour un appareil compatible sans mesure de puissance intégrée, utilisez une prise connectée qui mesure la puissance qu’il consomme. Si l’appareil dispose d’une commande de chauffage séparée, vous pouvez la choisir pour le piloter.

Les prix proviennent de Homey Energy, de Power by the Hour ou de vos Flows. Les heures pleines, les heures creuses et les frais de réseau renseignés dans la source choisie entrent dans la planification. PELS ajuste aussi le chauffage et la climatisation selon les prix au quart d'heure.

Dans Smart tasks, vous fixez un objectif et une échéance : une voiture à 80 % à 7 h, un salon chaud pour votre retour ou une quantité d'énergie à fournir au chauffe-eau. PELS privilégie les périodes moins chères selon la puissance disponible. Si Homey fournit le niveau de batterie de la voiture, PELS l’utilise pour planifier la recharge. Dans Schedules, programmez la création de Smart tasks ou un changement de mode à une heure précise, une fois ou les jours choisis. Pour un changement de mode programmé, PELS peut commencer à chauffer à l’avance.

Avec Grid import limit, vous réglez la limite de puissance prélevée sur le réseau selon les besoins de la maison. À son approche, PELS réduit la recharge, ajuste le chauffage ou met les appareils moins prioritaires en pause. Ils reprennent lorsque de la puissance est disponible.

Dans Main fuse, indiquez la puissance souscrite en kVA. Sur une installation triphasée avec neutre, PELS peut réduire la puissance sur une phase qui approche de sa limite si le compteur mesure chaque phase séparément.

Avec des panneaux solaires, le surplus sert à chauffer l'eau, préchauffer ou rafraîchir la maison et recharger la voiture. PELS adapte la puissance de recharge au surplus disponible. Le prix de vente au réseau est pris en compte, y compris s'il est négatif. PELS répartit le surplus entre vos appareils et votre batterie domestique selon vos priorités. Il peut aussi décharger la batterie pour respecter la limite de puissance. Parmi les modèles compatibles figurent Sessy, Marstek Venus, Zendure, Huawei LUNA2000, Sigenergy et Anker SOLIX. Si vous l'activez, PELS peut aussi vendre l'énergie stockée lorsque cela réduit vos coûts.

Des modes comme Home, Away ou Night définissent les températures et les priorités pour chaque situation.

Simulation mode permet de voir les décisions de PELS jusqu'à ce que vous choisissiez Start managing à la fin de la configuration.
