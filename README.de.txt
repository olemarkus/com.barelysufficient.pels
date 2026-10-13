Das Auto muss morgens geladen sein, die Wärmepumpe soll das Haus warm halten – möglichst dann, wenn der Strom günstig ist. PELS plant das Laden deines Autos und die Heizzeiten anhand deiner Strompreise und steuert unter anderem Wallboxen von Easee und Zaptec, Wärmepumpen, Thermostate und Warmwasserspeicher über die Steuerungsfunktionen ihrer Homey-Apps. Du legst fest, welche Geräte Vorrang haben, auch wenn sie von verschiedenen Herstellern stammen.

In Smart tasks legst du zum Beispiel fest, dass das Auto um 7 Uhr zu 80 % geladen oder das Wohnzimmer bei deiner Rückkehr warm sein soll. PELS wählt dafür die günstigsten Stunden. Ist der Akkustand in Homey verfügbar, berücksichtigt PELS ihn bei der Ladeplanung.

Die Preise kommen aus Homey Energy, Power by the Hour oder deinen Flows. In der gewählten Preisquelle hinterlegte Tarifzeiten und Netzentgelte gehen in die Planung ein. Für Heizung und Kühlung berücksichtigt PELS auch Viertelstundenpreise.

Erzeugt deine PV-Anlage mehr Strom, als das Haus gerade verbraucht, nutzt PELS den Überschuss fürs Warmwasser, zum Vorheizen oder Kühlen und zum Laden deines Autos. Die Ladeleistung wird an den Solarüberschuss angepasst. PELS berücksichtigt außerdem den Preis für die Einspeisung, auch wenn er negativ ist.

Ein Heimspeicher wie Sessy oder Marstek Venus nimmt den Solarüberschuss auf, den die anderen Geräte nicht nutzen. PELS reduziert die Ladeleistung des Speichers, wenn ein Gerät mit höherer Priorität Leistung braucht, und entlädt ihn, um die eingestellte Leistungsgrenze einzuhalten.

Mit Grid import limit reduziert PELS bei hohem Netzbezug die Ladeleistung, passt die Heizung an oder pausiert Geräte mit niedrigerer Priorität. Sobald wieder Leistung verfügbar ist, laufen sie weiter. Die Messwerte für das Haus kommen aus Homey Energy, einem Lesegerät für den Stromzähler oder einem Flow.

Mit Home, Away und Night sind Temperaturen und Prioritäten für unterschiedliche Tagesabläufe hinterlegt.

Die geführte Einrichtung findest du unter Homey > Mehr > Apps > PELS > Einstellungen. In Simulation mode siehst du zunächst, wie PELS deine Geräte steuern würde.
