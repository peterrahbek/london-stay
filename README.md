# London Accommodation Shortlist — May 2026

Live at: **https://peterrahbek.github.io/london-stay/**

## What is this?

A shortlist of ~30 London apartments (Booking.com + Airbnb) for May 10–14 2026.
Interactive map, filterable/sortable cards, and a 3-person star rating system for Peter, Anne, and Christian.

## How to rate

1. Open the link above
2. Click your name (Peter / Anne / Christian)
3. Click stars on any property
4. Ratings sync automatically — everyone sees each other's ratings on reload

Ratings are stored at jsonblob.com with localStorage as fallback.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main page — map, cards, scoring, ratings UI |
| `prices.json` | Price data loaded at runtime |
| `ratings.php` | PHP ratings API (for self-hosting, not used on GitHub Pages) |
| `airbnb-scrape.js` | Playwright scraper for Airbnb listings (run locally) |
| `PROJECT-BRIEF.md` | Detailed project documentation |

## Running the scraper

```bash
npm install playwright
npx playwright install chromium
node airbnb-scrape.js --use-real-chrome
```

## Testing locally

```bash
npx serve .
# Open http://localhost:3000
```
