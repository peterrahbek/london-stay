/**
 * Broader Airbnb search — multiple queries to maximize coverage.
 * Saves results to airbnb-raw.json (merging with existing).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = base => base + Math.floor(Math.random() * 1000);

const SEARCHES = [
  // 1. No bounding box, just London, sorted by relevance
  {
    name: 'London (no bbox)',
    url: 'https://www.airbnb.com/s/London--United-Kingdom/homes'
      + '?checkin=2026-05-10&checkout=2026-05-14&adults=4'
      + '&price_max=350&min_bedrooms=2&min_beds=2'
      + '&room_types[]=Entire%20home%2Fapt&currency=GBP',
  },
  // 2. Wider bounding box (include Notting Hill, Camden, Bermondsey)
  {
    name: 'Wide bbox',
    url: 'https://www.airbnb.com/s/London--United-Kingdom/homes'
      + '?checkin=2026-05-10&checkout=2026-05-14&adults=4'
      + '&price_max=400&min_bedrooms=2'
      + '&room_types[]=Entire%20home%2Fapt&currency=GBP'
      + '&ne_lat=51.56&ne_lng=0.00&sw_lat=51.46&sw_lng=-0.25',
  },
  // 3. Central only, lower min_beds (catches 2BR with just 2 beds listed)
  {
    name: 'Central, min_beds=0',
    url: 'https://www.airbnb.com/s/London--United-Kingdom/homes'
      + '?checkin=2026-05-10&checkout=2026-05-14&adults=4'
      + '&price_max=350&min_bedrooms=2'
      + '&room_types[]=Entire%20home%2Fapt&currency=GBP'
      + '&ne_lat=51.54&ne_lng=-0.05&sw_lat=51.48&sw_lng=-0.20',
  },
];

const MAX_PAGES = 10;

async function scrapeSearch(page, search) {
  console.log(`\n── ${search.name} ──`);
  console.log(`  URL: ${search.url.substring(0, 120)}...`);

  await page.goto(search.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);

  const allListings = [];
  const seenIds = new Set();

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    console.log(`  Page ${pageNum}...`);

    await page.waitForSelector('[data-testid="card-container"]', { timeout: 10000 }).catch(() => null);

    const listings = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="card-container"]');
      const results = [];
      cards.forEach(card => {
        const link = card.querySelector('a[href*="/rooms/"]');
        if (!link) return;
        const m = link.href.match(/\/rooms\/(\d+)/);
        if (!m) return;
        const inner = card.innerText.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        const totalMatch = inner.match(/£([\d,]+)\s+total/i);
        const priceMatch = inner.match(/£([\d,]+)\s+(?:for|per)/i) || totalMatch;
        const origPriceMatch = inner.match(/£([\d,]+)\s+£([\d,]+)\s+(?:for|total)/i)
          || inner.match(/Originally\s+£([\d,]+).*?£([\d,]+)/i);
        const ratingMatch = inner.match(/([\d.]+)\s+out of\s+5[^(]*\(?([\d,]+)\s+reviews?\)?/i)
          || inner.match(/([\d.]+)\s+\(([\d,]+)\)/);
        const bedroomsMatch = inner.match(/(\d+)\s+bedrooms?/);
        const priceStr = origPriceMatch ? origPriceMatch[2] : priceMatch ? priceMatch[1] : null;
        const origPriceStr = origPriceMatch ? origPriceMatch[1] : null;
        results.push({
          roomId: m[1],
          url: 'https://www.airbnb.com/rooms/' + m[1],
          price4n: priceStr ? parseInt(priceStr.replace(/,/g, '')) : null,
          origPrice4n: origPriceStr ? parseInt(origPriceStr.replace(/,/g, '')) : null,
          rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
          reviewCount: ratingMatch ? parseInt(ratingMatch[2].replace(/,/g, '')) : null,
          bedrooms: bedroomsMatch ? parseInt(bedroomsMatch[1]) : null,
          guestFavorite: inner.includes('Guest favor'),
          superhost: inner.includes('Superhost'),
          freeCancellation: inner.includes('Free cancellation'),
          scrapedAt: new Date().toISOString(),
        });
      });
      return results;
    });

    let newCount = 0;
    for (const l of listings) {
      if (!seenIds.has(l.roomId)) {
        seenIds.add(l.roomId);
        allListings.push(l);
        newCount++;
      }
    }
    console.log(`    ${listings.length} cards, ${newCount} new → total ${allListings.length}`);

    if (newCount === 0 && pageNum > 1) { console.log('    No new results, stopping.'); break; }

    const nextBtn = await page.$('[aria-label="Next"]');
    if (!nextBtn) { console.log('    No next button.'); break; }
    const disabled = await nextBtn.evaluate(el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
    if (disabled) { console.log('    Next disabled.'); break; }

    await nextBtn.click();
    await sleep(jitter(2500));
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await sleep(2000);
  }

  return allListings;
}

(async () => {
  const userDataDir = path.join(require('os').tmpdir(), 'pw-airbnb-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, channel: 'chrome', args: ['--start-maximized'],
    viewport: null, locale: 'en-GB', timezoneId: 'Europe/London',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Load existing raw data to merge
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync('airbnb-raw.json', 'utf8')); } catch(e) {}
  const seenGlobal = new Set(existing.map(l => l.roomId));
  let allNew = [...existing];

  for (const search of SEARCHES) {
    try {
      const results = await scrapeSearch(page, search);
      for (const r of results) {
        if (!seenGlobal.has(r.roomId)) {
          seenGlobal.add(r.roomId);
          allNew.push(r);
        }
      }
      console.log(`  Cumulative unique: ${allNew.length}`);
      // Save after each search
      fs.writeFileSync('airbnb-raw.json', JSON.stringify(allNew, null, 2));
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
    await sleep(3000);
  }

  console.log(`\n✓ Total unique listings: ${allNew.length}`);
  fs.writeFileSync('airbnb-raw.json', JSON.stringify(allNew, null, 2));
  await context.close();
})();
