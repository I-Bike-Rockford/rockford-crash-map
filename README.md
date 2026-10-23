# Rockford Crash Map

An initiative of I Bike Rockford, a volunteer group. A web map of fatal and serious-injury crashes in Rockford, Illinois, 2006–2025, built from Illinois Department of Transportation (IDOT) crash data, with person-level facts about fatal crashes from the federal FARS database.

This is a static website: open `index.html` through any web server. Nothing here is an official City of Rockford or IDOT product.

- `index.html`, `css/`, `js/`: the site
- `data/ka.json`: fatal and serious-injury crashes (loads first)
- `data/other.json`: minor, possible and no-injury crashes (loads on request)
- `downloads/Rockford_Crashes_2006-2025.csv`: the full crash file, described on the site's Data page
- `vendor/leaflet`: Leaflet 1.9.4 (BSD-2-Clause)

Map tiles: CARTO / OpenStreetMap contributors; Esri World Imagery for the satellite option. Address search uses OpenStreetMap Nominatim.

Questions and corrections: ibikerockford@gmail.com 
