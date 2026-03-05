# London Trip Accommodation Shortlist — Project Brief

## The trip
- **Who:** Peter + Anne + Emilie (daughter, 14) + Christian (brother)
- **When:** May 10–14, 2026 (4 nights)
- **Budget:** £1,400 hard ceiling (£1,500 absolute max). Display in DKK at 8.58 FX rate.
- **Must-have:** Two sleeping areas — BR1 for Peter/Anne/Emilie, BR2 for Christian with a **proper bed** (not a sofa)

## Already booked (comparison baseline)
**Burlington Residence**, Mayfair/Soho (W1S 2ET) — £1,320 / 11.326 kr  
3BR, king per room, kitchen, washer, dishwasher, terrace, 8.2/10 rating, free cancellation until May 8.

## Current state of the shortlist
The main artifact is `london.html` — a self-contained HTML file with an embedded Leaflet/OSM map, filterable/sortable property cards, and a 3-person star rating system (Peter/Anne/Christian). It loads prices from `prices.json` at runtime.

**32 properties currently in the file:**
- 20 Booking.com listings — verified URLs, verified prices, solid data
- 12 Airbnb listings — verified live URLs (HTTP 200), but most have `beds TBC` and several have placeholder/wrong neighbourhoods

**The Airbnb side is the problem.** We have spent considerable time trying to scrape Airbnb via Claude.ai's Chrome extension, fabricated IDs slipped in when scraping failed, and locations were guessed. The 12 current Airbnb listings should be treated as a stub pending a proper rescrape.

## Bed configuration scoring (critical)
| Score | Meaning |
|-------|---------|
| 5 | Everyone gets a real bed — Christian has own BR, Emilie has own bed |
| 4 | Christian has own BR with real bed, Emilie on sofa bed |
| 3 | Only 2 real beds total, or config unverified |
| 2 | Poor fit |

## Weighted scoring formula
| Factor | Weight | Notes |
|--------|--------|-------|
| Price | 30% | ≤£1,400 = 100, >£1,500 = 10 |
| Room config | 25% | Score above × 20 |
| Location | 20% | ≤2km from centre = 100, 3km = 75, 4km = 55, 5km+ = low |
| Guest rating | 15% | ≥9.0 = 100, ≥8.5 = 85, ≥8.0 = 65 |
| Review count | 10% | ≥500 = 100, ≥100 = 80, ≥20 = 60, <5 = 15 |

## File structure
```
london.html       — main artifact (map + cards + rating UI)
prices.json       — price data separated from HTML, loaded at runtime
airbnb-scrape.js  — Playwright scraper (see below)
```

### prices.json format
```json
{
  "_meta": { "scraped": "2026-03-05", "currency": "GBP", "checkin": "2026-05-10", "checkout": "2026-05-14", "nights": 4 },
  "prices": [
    { "id": 1, "p": 946, "po": 1262 },
    ...
  ]
}
```
`p` = actual price, `po` = original/crossed-out price (for showing savings).

### london.html property data format
Each property object in the `PROPERTIES` array:
```js
{id, pl, n, r, rv, a, km, br, beds, ba, genius, fc, cs, cn, k, w, roomId/slug}
```
- `pl` — platform: "Booking.com" or "Airbnb"
- `r` — guest rating (0–10 scale, Airbnb 4.x converted × 2)
- `rv` — review count
- `a` — neighbourhood name (must match a key in `AREA_LL`)
- `km` — distance from centre (Trafalgar Square)
- `br` — bedroom count
- `beds` — human-readable bed description e.g. "2 dbls, 1 sofa"
- `ba` — bathroom count
- `genius` — Booking.com Genius Level 3 discount applies
- `fc` — free cancellation
- `cs` — config score 2–5 (see table above)
- `cn` — short config note shown on card
- `k` / `w` — kitchen / washer
- `roomId` — Airbnb room ID (numeric string), used to build URL
- `slug` — Booking.com URL slug

## The Airbnb scraper
`airbnb-scrape.js` uses Playwright to:
1. Scrape search results (saves `airbnb-raw.json` after each page)
2. Visit each room page to extract bed types, neighbourhood, postcode (saves `airbnb-beds.json` after each room)
3. Merge into `airbnb-merged.json` with a summary table

**Run it:**
```bash
npm install playwright
npx playwright install chromium
node airbnb-scrape.js                  # standard run
node airbnb-scrape.js --use-real-chrome  # use logged-in Chrome (best)
node airbnb-scrape.js --beds-only      # resume Phase 2 after a crash
```

**After scraping**, the task is to update `london.html` and `prices.json` with the verified data from `airbnb-merged.json`.

## What needs doing
1. **Run the scraper** to get clean Airbnb data
2. **Update london.html** — replace the 12 stub Airbnb entries with verified listings from `airbnb-merged.json`: correct neighbourhoods, real km distances, actual bed descriptions, correct config scores
3. **Update prices.json** — add/correct Airbnb prices from scrape output
4. **Sanity-check locations** — `km` values should reflect actual distance from Trafalgar Square (51.5080, -0.1281). Flag anything over 4.5km.
5. Optionally: **rescan Booking.com** for any properties in £1,000–1,400 range not already in the list

## Key principles from previous sessions
- **Save incrementally** — write files after every unit of work, not at the end
- **No fabricated data** — if a value can't be confirmed, leave it as null or "TBC", never guess
- **Single source of truth** — `london.html` + `prices.json`. Don't create parallel files that diverge.
- **Spec before coding** — agree on what the output should look like before writing code

## Loyalties / memberships (relevant for Booking.com)
- Booking.com Genius Level 3
- Hotels.com Rewards
- Hilton Honors
