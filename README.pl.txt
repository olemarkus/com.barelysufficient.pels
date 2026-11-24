PELS wykorzystuje nadwyżki z fotowoltaiki do ładowania auta, podgrzewania wody i ogrzewania domu. Moc ładowania reguluje tak, by zużyć więcej prądu z paneli na miejscu zamiast oddawać go do sieci.

Po instalacji otwórz Homey > Więcej > Aplikacje > PELS > Ustawienia, aby dokończyć konfigurację.

PELS rozdziela nadwyżki między urządzenia i domowy magazyn energii według ustalonych przez Ciebie priorytetów. Obsługuje m.in. Sessy, Marstek Venus, Zendure, Huawei LUNA2000, Sigenergy i Anker SOLIX. Może też użyć zgromadzonej energii, by utrzymać pobór z sieci poniżej ustawionego limitu. Po włączeniu tej opcji PELS może sprzedawać zgromadzoną energię, gdy obniża to Twoje koszty.

Ceny rynkowe dla Polski dostarcza aplikacja Power by the Hour. Ceny z Twojej taryfy, także zależne od pory dnia, możesz przekazywać przez automatyzacje Flow. PELS uwzględnia opłaty dystrybucyjne i podatki zawarte w dostarczonych cenach. Ogrzewanie i chłodzenie dostosowuje do tańszych i droższych godzin.

W Smart tasks ustawiasz cel i termin: na przykład auto naładowane do 80% przed 07:00 albo ciepły salon po powrocie z pracy. PELS wybiera tańsze pory, w których dostępna jest wystarczająca moc. Przy planowaniu ładowania uwzględnia poziom naładowania akumulatora auta, jeśli Homey go udostępnia. W Schedules możesz zaplanować tworzenie Smart tasks lub zmianę trybu o określonej godzinie, jednorazowo albo w wybrane dni. PELS może rozpocząć ogrzewanie przed zaplanowaną zmianą trybu.

Grid import limit ogranicza bieżący pobór mocy z sieci. Gdy pobór zbliża się do ustawionego limitu, PELS zmniejsza moc ładowania auta lub wstrzymuje urządzenia o niższym priorytecie. Wznawia ich pracę, gdy można je uruchomić w ramach ustawionego limitu.

PELS obsługuje urządzenia różnych producentów, w tym ładowarki Easee, Zaptec, Alfen, Peblar, Wallbox i Zappi. Steruje nimi za pomocą funkcji ich aplikacji Homey.

Jeśli zgodne urządzenie nie mierzy własnego poboru mocy, możesz użyć inteligentnego gniazdka z pomiarem. Jeśli urządzenie ma osobny przełącznik ogrzewania, możesz wybrać go do sterowania.

Simulation mode pokazuje, jak PELS sterowałby urządzeniami, dopóki na końcu konfiguracji nie wybierzesz Start managing.
