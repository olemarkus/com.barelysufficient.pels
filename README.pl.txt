PELS wykorzystuje nadwyżki z fotowoltaiki do ładowania auta, podgrzewania wody i ogrzewania domu. Moc ładowania reguluje tak, by zużyć więcej prądu z paneli na miejscu, zamiast oddawać go do sieci.

Domowy magazyn energii może gromadzić nadwyżki, których nie potrzebują pozostałe urządzenia. Gdy urządzenia o wyższym priorytecie potrzebują więcej mocy, PELS ogranicza ładowanie magazynu. Może też wykorzystać zgromadzoną energię, by utrzymać pobór z sieci w ustawionym limicie.

Ceny rynkowe dla Polski dostarcza aplikacja Power by the Hour. Stawki z własnej taryfy, także zależne od pory dnia, możesz przekazywać przez scenariusze Flow. PELS korzysta z cen przekazanych przez wybrane źródło, łącznie z zawartymi w nich opłatami dystrybucyjnymi i podatkami. Ogrzewanie i chłodzenie dostosowuje do tańszych i droższych godzin.

W Smart tasks ustawiasz cel i termin: na przykład auto naładowane do 80% przed 07:00 albo ciepły salon po powrocie z pracy. PELS wybiera tańsze godziny ładowania i grzania. Odczytuje też poziom naładowania akumulatora z auta powiązanego z ładowarką w Homey.

Grid import limit ogranicza bieżący pobór mocy z sieci. Gdy pobór zbliża się do ustawionego limitu, PELS zmniejsza moc ładowania auta lub wstrzymuje urządzenia o niższym priorytecie. Wznawia ich pracę, gdy znów jest dostępna moc.

Ładowarka, pompa ciepła i magazyn energii mogą pochodzić od różnych producentów. Zakres sterowania zależy od funkcji udostępnionych przez ich integracje w Homey: regulacji mocy, zmiany temperatury lub włączania i wyłączania.

Konfigurację znajdziesz w Homey > Więcej > Aplikacje > PELS > Ustawienia. Simulation mode pokazuje, jak PELS sterowałby urządzeniami, zanim włączysz automatyczne sterowanie.
