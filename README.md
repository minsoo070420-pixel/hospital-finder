# Nearby Hospitals Map

A small self-contained web app that shows hospitals near a location on an interactive
map, whether each one appears to be open right now, and what insurance it accepts.

## Running it

No build step or install required. Because the app fetches data from external APIs,
open it through a local server rather than double-clicking the file (some browsers
block `fetch()` from `file://` pages):

```bash
cd ~/Desktop/map
python3 -m http.server 8010
```

Then open `http://localhost:8010` in your browser.

## What it does

- **Map**: [Leaflet](https://leafletjs.com/) rendering OpenStreetMap tiles — free, no API key needed.
- **Hospital locations**: fetched live from the [Overpass API](https://overpass-api.de/)
  (OpenStreetMap's query service), searching for `amenity=hospital` within the selected
  radius of the map center.
- **Search**: type any place/address and it's geocoded via OpenStreetMap's
  [Nominatim](https://nominatim.org/) service.
- **"Use my location"**: uses the browser's Geolocation API.
- **Open/closed status**: computed client-side from each hospital's OSM `opening_hours`
  tag using a simplified parser in `app.js` (`evaluateOpeningHours`). It supports `24/7`,
  day ranges/lists (e.g. `Mo-Fr`, `Sa,Su`), multiple time ranges, and `;`-separated rule
  groups. It does **not** implement the full OSM opening_hours spec (public holidays,
  seasons, etc.) — anything it can't confidently parse is shown as "Hours unknown"
  rather than guessed.
- **Insurance accepted**: there is no public API that tracks which insurance plans a
  specific hospital accepts, so this comes from the local `insurance-data.json` file,
  matched by hospital name. It ships with a few dozen sample hospitals filled in
  across the US, Canada, and South Korea.
- **Review summaries**: shows "Coming soon" until you add an entry to
  `reviews-data.json`. Live review data turned out not to be practically available —
  Google Places requires a billing-enabled Cloud project, and Yelp's signup got stuck
  in a persistent bot-check loop — so this is deliberately manual/local for now (same
  pattern as insurance data), rather than fabricated review content about real
  hospitals.

## Editing insurance data

Open `insurance-data.json` and add an entry keyed by the hospital's exact OpenStreetMap
`name` tag, lowercased:

```json
"some hospital name": {
  "insurances": ["Aetna", "Cigna", "Medicare", "Medicaid"]
}
```

If a hospital on the map isn't in this file, the popup shows "Not listed — verify with
the hospital" instead of making something up.

## Editing review data

Open `reviews-data.json` and add an entry keyed by the hospital's exact OpenStreetMap
`name` tag, lowercased (same naming rules as `insurance-data.json` — check against
live Overpass data, don't assume the common/marketing name):

```json
"some hospital name": {
  "rating": 4.2,
  "summary": "Brief summary you write after reading real reviews."
}
```

If a hospital isn't in this file, the popup just shows "Coming soon" instead of
inventing something.

## Known limitations

- OSM hospital data quality (address, phone, hours) varies a lot by region — dense
  cities tend to be well-mapped, rural areas less so.
- The public Overpass and Nominatim instances used here are free but rate-limited;
  avoid hammering them with rapid repeated searches.
- Insurance data is manually maintained sample data, not a live feed — always verify
  directly with the hospital before relying on it for care decisions.
