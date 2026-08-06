How's my friend at work doing? — Local Edition (Windows)
========================================================

WHAT THIS IS
  A personal, non-operational tool that connects to the FAA's public SWIM data
  feeds and shows live flights, radar scopes, surface traffic, and more — all
  running entirely on your own computer. Nothing is uploaded anywhere.

HOW TO RUN
  1. Double-click  SwimServer.exe
     (Windows SmartScreen may warn about an unsigned app — click
      "More info" > "Run anyway".)
  2. Your browser opens to a setup page the first time.
  3. Enter your FAA SWIM SCDS credentials (see below) and click Save.
  4. Close the window and start SwimServer.exe again. Done — it connects and
     the pages fill with live data.

  Leave the console window open while you use it; closing it stops the server.

GETTING SWIM CREDENTIALS (one time, free)
  This tool needs your OWN subscription to the FAA feeds:
  1. Make an account at  https://portal.swim.faa.gov/
  2. Open SCDS (SWIM Cloud Distribution Service) and request a subscription to
     the products you want:
        SFDPS  - en-route flights   (start here; the rest are optional)
        STDDS  - terminal / ASDE-X / TDLS / TAIS
        TFMS   - traffic flow / EDCT
        TFDM   - surface / departure metering
        ITWS   - terminal weather
  3. Once approved, each product gives you a host, VPN, username, password, and
     queue name. Paste them into the setup page.

CHANGING SETTINGS LATER
  Open  http://localhost:5001/setup  (or your chosen port) in a browser, or edit
  swimreader.config.json next to the exe. Restart the app to apply changes.
  To change the port, set it on the setup page and restart.

SECTOR BOUNDARY MAPS
  ARTCC sector-boundary maps are included and the ERAM scope loads them
  automatically:
        AllSectors.kml       - loaded automatically by the ERAM scope
        AllHighSectors.kml   - optional, toggle in the scope sidebar
        AllLowSectors.kml    - optional, toggle in the scope sidebar
  These come from a public CWSU (Center Weather Service Unit) map layer on the
  National Weather Service site, https://www.weather.gov/zse . To use your own
  instead, replace the KML files next to SwimServer.exe and restart. KML
  categories are read from each placemark's <name> tag (UHI / HI / LO / APP).

IMPORTANT
  All SCDS data is pre-approved for public release by the FAA NAS Data Release
  Board and is NOT for operational use. This tool is for personal, non-
  operational visualization only.
