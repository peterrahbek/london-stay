/**
 * airbnb-scrape.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scrapes Airbnb London search results for May 10-14 2026, 4 guests.
 * Outputs: airbnb-raw.json  (all search result listings)
 *          airbnb-beds.json (bed config detail for each listing)
 *
 * USAGE (in Claude Code or terminal):
 *   npm install playwright
 *   npx playwright install chromium
 *   node airbnb-scrape.js
 *
 * To use your real Chrome profile instead (avoids bot detection):
 *   node airbnb-scrape.js --use-real-chrome
 *
 * Resume a partial run (skips already-fetched room IDs in airbnb-beds.json):
 *   node airbnb-scrape.js --beds-only
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  checkin:   '2026-05-10',
  checkout:  '2026-05-14',
  adults:    4,      // Airbnb treats 14-year-olds as adults
  children:  0,
  priceMax:  500,       // per night GBP — generous, we filter later
  minBeds:   2,         // relaxed — we score bed config ourselves
  minBedrooms: 2,
  // Bounding box: central London + close suburbs only
  // Roughly: N Hampstead, S Brixton, W Shepherd's Bush, E Bethnal Green
  bounds: {
    neLat:  51.550,
    neLng: -0.040,
    swLat:  51.470,
    swLng: -0.225,
  },
  outputRaw:  'airbnb-raw.json',
  outputBeds: 'airbnb-beds.json',
  delayBetweenPages:   2500,   // ms between search result pages
  delayBetweenRooms:   3000,   // ms between individual room pages
  maxPages: 15,                 // safety limit
};

const SEARCH_URL = () => {
  const b = CONFIG.bounds;
  return (
    `https://www.airbnb.com/s/London--United-Kingdom/homes` +
    `?checkin=${CONFIG.checkin}` +
    `&checkout=${CONFIG.checkout}` +
    `&adults=${CONFIG.adults}` +
    `&price_max=${CONFIG.priceMax}` +
    `&min_bedrooms=${CONFIG.minBedrooms}` +
    `&min_beds=${CONFIG.minBeds}` +
    `&room_types[]=Entire%20home%2Fapt` +
    `&currency=GBP` +
    `&ne_lat=${b.neLat}&ne_lng=${b.neLng}` +
    `&sw_lat=${b.swLat}&sw_lng=${b.swLng}`
  );
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * 1000);

function saveJSON(filename, data) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`  ✓ Saved ${filename} (${Array.isArray(data) ? data.length : Object.keys(data).length} entries)`);
}

function loadJSON(filename) {
  if (fs.existsSync(filename)) {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  return null;
}

// ── PHASE 1: SCRAPE SEARCH RESULTS ───────────────────────────────────────────
async function scrapeSearchResults(page) {
  console.log('\n── PHASE 1: Search results ──────────────────────────────────');
  const allListings = [];
  const seenIds = new Set();

  console.log(`  URL: ${SEARCH_URL()}`);
  await page.goto(SEARCH_URL(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000); // let Airbnb JS render

  for (let pageNum = 1; pageNum <= CONFIG.maxPages; pageNum++) {
    console.log(`\n  Page ${pageNum}...`);

    // Wait for cards to load
    const cardsFound = await page.waitForSelector('[data-testid="card-container"]', { timeout: 15000 })
      .catch(() => null);
    if (!cardsFound) {
      console.log('  ⚠ No cards found — dumping page state for debugging:');
      console.log('    Title:', await page.title());
      console.log('    URL:', page.url());
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log('    Body:', bodyText.replace(/\n/g, ' ').substring(0, 300));
      await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
      console.log('    Screenshot saved: debug-screenshot.png');
    }

    // Debug: dump what we see
    const debugInfo = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="card-container"]');
      const allLinks = [...document.querySelectorAll('a[href*="/rooms/"]')].map(a => a.href).slice(0, 5);
      const bodySnippet = document.body.innerText.substring(0, 500).replace(/\n/g, ' ');
      return { cardCount: cards.length, sampleLinks: allLinks, bodySnippet, title: document.title, url: location.href };
    });
    console.log(`    Debug: ${debugInfo.cardCount} card-containers, ${debugInfo.sampleLinks.length} /rooms/ links`);
    if (debugInfo.cardCount === 0) {
      console.log(`    Title: ${debugInfo.title}`);
      console.log(`    Body: ${debugInfo.bodySnippet.substring(0, 300)}`);
      await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
      console.log('    Screenshot: debug-screenshot.png');
    }
    if (debugInfo.sampleLinks.length > 0) console.log(`    Sample links: ${debugInfo.sampleLinks.join(', ')}`);

    // Extract listings from current page
    const listings = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="card-container"]');
      const results = [];

      cards.forEach(card => {
        const link = card.querySelector('a[href*="/rooms/"]');
        if (!link) return;

        const m = link.href.match(/\/rooms\/(\d+)/);
        if (!m) return;

        const inner = card.innerText.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        // Price: look for "£NNN total" or "£NNN for 4 nights" or per-night "£NNN night"
        const totalMatch = inner.match(/£([\d,]+)\s+total/i);
        const priceMatch = inner.match(/£([\d,]+)\s+(?:for\s+4\s+nights|per\s+night)/i) || totalMatch;
        const origPriceMatch = inner.match(/£([\d,]+)\s+£([\d,]+)\s+(?:for|total)/i)
          || inner.match(/Originally\s+£([\d,]+).*?£([\d,]+)/i);

        // Rating and review count
        const ratingMatch = inner.match(/([\d.]+)\s+out of\s+5[^(]*\(?([\d,]+)\s+reviews?\)?/i)
          || inner.match(/([\d.]+)\s+\(([\d,]+)\)/);

        // Beds and bedrooms
        const bedsMatch = inner.match(/(\d+)\s+beds?/);
        const bedroomsMatch = inner.match(/(\d+)\s+bedrooms?/);

        // Guest favourite / Superhost
        const isGuestFav = inner.includes('Guest favorite') || inner.includes('Guest favourite');
        const isSuperhost = inner.includes('Superhost');
        const hasFreeCancellation = inner.includes('Free cancellation');

        const priceStr = origPriceMatch ? origPriceMatch[2] : priceMatch ? priceMatch[1] : null;
        const origPriceStr = origPriceMatch ? origPriceMatch[1] : null;

        results.push({
          roomId: m[1],
          url: `https://www.airbnb.com/rooms/${m[1]}`,
          price4n: priceStr ? parseInt(priceStr.replace(/,/g, '')) : null,
          origPrice4n: origPriceStr ? parseInt(origPriceStr.replace(/,/g, '')) : null,
          rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
          reviewCount: ratingMatch ? parseInt(ratingMatch[2].replace(/,/g, '')) : null,
          beds: bedsMatch ? parseInt(bedsMatch[1]) : null,
          bedrooms: bedroomsMatch ? parseInt(bedroomsMatch[1]) : null,
          guestFavorite: isGuestFav,
          superhost: isSuperhost,
          freeCancellation: hasFreeCancellation,
          scrapedAt: new Date().toISOString(),
        });
      });

      return results;
    });

    let newThisPage = 0;
    for (const l of listings) {
      if (!seenIds.has(l.roomId)) {
        seenIds.add(l.roomId);
        allListings.push(l);
        newThisPage++;
      }
    }
    console.log(`  Found ${listings.length} cards, ${newThisPage} new. Total: ${allListings.length}`);

    // Save incrementally after each page
    saveJSON(CONFIG.outputRaw, allListings);

    // Check for next page
    const nextBtn = await page.$('[aria-label="Next"]');
    if (!nextBtn) {
      console.log('  No next page button — done.');
      break;
    }

    // Check if next button is disabled
    const isDisabled = await nextBtn.evaluate(el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
    if (isDisabled) {
      console.log('  Next button disabled — done.');
      break;
    }

    // Click next page
    await nextBtn.click();
    await sleep(jitter(CONFIG.delayBetweenPages));

    // Wait for page to update
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await sleep(2000);
  }

  console.log(`\n  PHASE 1 complete. ${allListings.length} listings scraped.`);
  return allListings;
}

// ── PHASE 2: SCRAPE INDIVIDUAL ROOM PAGES ─────────────────────────────────────
async function scrapeRoomDetails(page, listings) {
  console.log('\n── PHASE 2: Room details (beds, location) ───────────────────');

  // Load existing beds data to support resume
  const existing = loadJSON(CONFIG.outputBeds) || [];
  const doneIds = new Set(existing.map(r => r.roomId));
  const bedsData = [...existing];

  const todo = listings.filter(l => !doneIds.has(l.roomId));
  console.log(`  ${doneIds.size} already done, ${todo.length} remaining`);

  for (let i = 0; i < todo.length; i++) {
    const listing = todo[i];
    console.log(`  [${i + 1}/${todo.length}] ${listing.roomId}...`);

    try {
      await page.goto(
        `https://www.airbnb.com/rooms/${listing.roomId}` +
        `?check_in=${CONFIG.checkin}&check_out=${CONFIG.checkout}` +
        `&adults=${CONFIG.adults}&currency=GBP`,
        { waitUntil: 'domcontentloaded', timeout: 25000 }
      );

      await sleep(2000);

      // Dismiss translation modal if present
      const closeBtn = await page.$('button[aria-label="Close"], [data-testid="translation-announce-modal"] button');
      if (closeBtn) { await closeBtn.click(); await sleep(500); }

      const detail = await page.evaluate(() => {
        const body = document.body.innerText;

        // ── Title ──
        const title = document.querySelector('h1')?.innerText?.trim() || '';

        // ── Location / neighbourhood ──
        // Airbnb puts it in the page title as "Type in NEIGHBOURHOOD, City"
        const pageTitle = document.title || '';
        const titleLocMatch = pageTitle.match(/in\s+([^,–—-]+(?:,\s*[^,–—-]+)?)\s*[-–—]/);

        // Also look in the location section
        const locationSection = document.querySelector('[data-section-id="LOCATION_DEFAULT"]');
        const locationText = locationSection?.innerText?.substring(0, 300) || '';

        // Extract postcode
        const postcodeMatch = body.match(/\b([A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2})\b/);

        // ── Sleeping arrangements ──
        // Look for the bedroom section which lists bed types
        const sleepingSection = [...document.querySelectorAll('div, section')]
          .find(el => el.innerText?.match(/Bedroom\s+\d|Where you.ll sleep|sleeping arrangement/i)
            && el.innerText?.length < 2000);
        const sleepingText = sleepingSection?.innerText?.replace(/\n/g, ' ') || '';

        // Count specific bed types in the description
        const kingBeds    = (body.match(/king[\s-]?(?:size[d]?)?\s+bed/gi) || []).length;
        const queensBeds  = (body.match(/queen[\s-]?(?:size[d]?)?\s+bed/gi) || []).length;
        const doubleBeds  = (body.match(/double\s+bed/gi) || []).length;
        const twinBeds    = (body.match(/twin\s+bed/gi) || []).length;
        const sofaBeds    = (body.match(/sofa\s*(?:-\s*)?bed|sofabed|pull[\s-]out/gi) || []).length;
        const singleBeds  = (body.match(/single\s+bed/gi) || []).length;

        // Total beds from the summary line
        const totalBedsMatch = body.match(/(\d+)\s+beds?\s*·/);
        const totalBeds = totalBedsMatch ? parseInt(totalBedsMatch[1]) : null;

        // Bedrooms
        const bedroomsMatch = body.match(/(\d+)\s+bedrooms?\s*·/);
        const bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1]) : null;

        // Bathrooms
        const bathroomsMatch = body.match(/(\d+(?:\.\d+)?)\s+bath(?:room)?s?\s*[·\n]/i);
        const bathrooms = bathroomsMatch ? parseFloat(bathroomsMatch[1]) : null;

        // ── Nearby tube stations mentioned ──
        const tubeMatches = body.match(/\b([\w\s]+(?:tube|underground|station|line)[\w\s]*)\b/gi) || [];
        const tubeText = [...new Set(tubeMatches.slice(0, 8))].join(', ');

        // ── Neighbourhood keywords ──
        const londonAreas = [
          'Mayfair','Soho','Covent Garden','Fitzrovia','Marylebone','Clerkenwell',
          'Islington','Angel','Shoreditch','Hoxton','Hackney','Dalston',
          'Kings Cross','King\'s Cross','Bloomsbury','Holborn','Southwark',
          'Borough','London Bridge','Bermondsey','Waterloo','Southbank',
          'South Bank','Westminster','Pimlico','Belgravia','Chelsea','Fulham',
          'Notting Hill','Bayswater','Paddington','Little Venice',
          'Maida Vale','St John\'s Wood','Swiss Cottage','Camden','Kentish Town',
          'Primrose Hill','Kilburn','Cricklewood','Hampstead','Highbury',
          'Finsbury Park','Stoke Newington','Bethnal Green','Mile End',
          'Stepney','Whitechapel','Tower Hamlets','Canary Wharf','Kensington',
          'Earl\'s Court','Earls Court','West Kensington','Hammersmith',
          'Shepherd\'s Bush','Battersea','Clapham','Brixton','Stockwell',
          'Elephant','Oval','Kennington','Vauxhall','Pimlico',
          'Regents Park','Regent\'s Park','Haggerston','Hackney Wick'
        ];
        const foundAreas = londonAreas.filter(a =>
          new RegExp('\\b' + a.replace("'","'?") + '\\b', 'i').test(body)
        );

        // ── Availability check ──
        // If the page shows "Add dates" or "not available" the listing isn't bookable for these dates
        const notAvailable = /Add dates for prices|not available|unavailable|sold out/i.test(body);
        const reserveBtn = document.querySelector('[data-testid="homes-pdp-cta-btn"]');
        const reserveText = reserveBtn?.innerText || '';
        const isBookable = !notAvailable && /reserve|book/i.test(reserveText);

        // ── Price (in case not captured in search) ──
        // Match GBP: "£1,280 for 4 nights" or "£320 x 4 nights"
        // Match DKK: "kr 10,980 for 4 nights" or "DKK 10,980"
        const priceMatch = body.match(/£([\d,]+)\s+(?:for|×|x)\s+4\s+nights/)
          || body.match(/£([\d,]+)\s+total/i)
          || body.match(/Total\s+£([\d,]+)/i);

        return {
          title,
          pageTitle: pageTitle.substring(0, 120),
          locationText: locationText.substring(0, 200),
          postcode: postcodeMatch ? postcodeMatch[1] : null,
          foundAreas: [...new Set(foundAreas)],
          tubeNearby: tubeText.substring(0, 200),
          sleepingText: sleepingText.substring(0, 400),
          bedTypes: { king: kingBeds, queen: queensBeds, double: doubleBeds, twin: twinBeds, sofa: sofaBeds, single: singleBeds },
          totalBeds,
          bedrooms,
          bathrooms,
          available: isBookable,
          price4n: priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null,
          scrapedAt: new Date().toISOString(),
        };
      });

      bedsData.push({ roomId: listing.roomId, ...detail });
      const avail = detail.available ? '✓' : '✗ NOT AVAILABLE';
      console.log(`    ${avail} "${detail.title.substring(0, 50)}" | Areas: ${detail.foundAreas.slice(0, 3).join(', ')} | Beds: ${JSON.stringify(detail.bedTypes)}${detail.price4n ? ' | £'+detail.price4n : ''}`);

    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
      bedsData.push({ roomId: listing.roomId, error: err.message, scrapedAt: new Date().toISOString() });
    }

    // Save after every room
    saveJSON(CONFIG.outputBeds, bedsData);
    await sleep(jitter(CONFIG.delayBetweenRooms));
  }

  console.log(`\n  PHASE 2 complete. ${bedsData.length} rooms detailed.`);
  return bedsData;
}

// ── PHASE 3: MERGE + SUMMARISE ────────────────────────────────────────────────
function mergeAndSummarise(raw, beds) {
  console.log('\n── PHASE 3: Merge & summarise ───────────────────────────────');

  const bedsMap = {};
  beds.forEach(b => { bedsMap[b.roomId] = b; });

  const merged = raw.map(r => {
    const b = bedsMap[r.roomId] || {};

    // Determine neighbourhood: prefer found areas from room page
    const areas = b.foundAreas || [];
    // Score areas by how central they are (earlier in list = more central)
    const centralAreas = [
      'Soho','Covent Garden','Fitzrovia','Westminster','Clerkenwell',
      'Islington','Angel','Shoreditch','Bloomsbury','Holborn',
      'Southwark','Borough','Southbank','South Bank','Marylebone',
      'Waterloo','Kings Cross',"King's Cross",'Pimlico'
    ];
    const centralFound = areas.find(a => centralAreas.includes(a));
    const neighbourhood = centralFound || areas[0] || 'London (unverified)';

    // Bed config score
    const bt = b.bedTypes || {};
    const totalRealBeds = (bt.king||0) + (bt.queen||0) + (bt.double||0) + (bt.twin||0) + (bt.single||0);
    const sofaBeds = bt.sofa || 0;
    const bathrooms = b.bathrooms || 1;

    // Score: 5=everyone gets real bed, 4=Emilie on sofa, 3=unknown/poor
    let configScore = 3;
    let configNote = 'Verify bed config';
    if (totalRealBeds >= 3) {
      configScore = 5;
      configNote = `${totalRealBeds} real beds (${bathrooms} bath)`;
    } else if (totalRealBeds === 2 && sofaBeds >= 1) {
      configScore = 4;
      configNote = `2 real beds + sofa bed for Emilie`;
    } else if (totalRealBeds === 2) {
      configScore = 3;
      configNote = `Only 2 real beds — brother needs proper bed`;
    }

    return {
      roomId: r.roomId,
      url: r.url,
      title: b.title || '(title not scraped)',
      neighbourhood,
      allAreas: areas,
      postcode: b.postcode || null,
      price4n: r.price4n || b.price4n,
      origPrice4n: r.origPrice4n,
      rating: r.rating,
      reviewCount: r.reviewCount,
      guestFavorite: r.guestFavorite,
      superhost: r.superhost,
      freeCancellation: r.freeCancellation,
      bedrooms: b.bedrooms || r.bedrooms,
      totalBeds: b.totalBeds || r.beds,
      bathrooms: b.bathrooms,
      bedTypes: b.bedTypes || {},
      sofaBeds,
      sleepingText: b.sleepingText || '',
      configScore,
      configNote,
      tubeNearby: b.tubeNearby || '',
    };
  });

  // Sort by price
  merged.sort((a, b) => (a.price4n || 9999) - (b.price4n || 9999));

  saveJSON('airbnb-merged.json', merged);

  // Print summary table
  console.log('\n  ┌─────────────┬───────────────────────────────────────────┬──────┬───┬────┐');
  console.log('  │ Room ID     │ Title / Neighbourhood                     │ £4n  │ ★ │ Cfg│');
  console.log('  ├─────────────┼───────────────────────────────────────────┼──────┼───┼────┤');
  merged.forEach(m => {
    const id = m.roomId.substring(0, 11).padEnd(11);
    const name = (m.title.substring(0, 22) + ' / ' + m.neighbourhood).substring(0, 43).padEnd(43);
    const price = String(m.price4n || '?').padStart(5);
    const rating = String(m.rating || '?').padStart(3);
    const cfg = String(m.configScore).padStart(3);
    console.log(`  │ ${id} │ ${name} │ ${price} │ ${rating} │ ${cfg} │`);
  });
  console.log('  └─────────────┴───────────────────────────────────────────┴──────┴───┴────┘');

  return merged;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const bedsOnly = args.includes('--beds-only');
  const useRealChrome = args.includes('--use-real-chrome');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Airbnb London scraper — May 2026                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Mode: ${bedsOnly ? 'beds-only (resume)' : 'full scrape'}`);
  console.log(`  Browser: ${useRealChrome ? 'real Chrome profile' : 'Playwright Chromium'}`);
  console.log(`  Search bounds: NE ${CONFIG.bounds.neLat},${CONFIG.bounds.neLng} | SW ${CONFIG.bounds.swLat},${CONFIG.bounds.swLng}`);
  console.log(`  Dates: ${CONFIG.checkin} → ${CONFIG.checkout} | ${CONFIG.adults} adults`);
  console.log(`  Filters: entire home, ≥${CONFIG.minBedrooms} BR, ≥${CONFIG.minBeds} beds, ≤£${CONFIG.priceMax}/night\n`);

  let browser, context;

  if (useRealChrome) {
    // Use the real Chrome binary (better fingerprint vs bot detection)
    // but with a dedicated Playwright profile dir (Chrome won't allow
    // DevTools debugging on its default profile directory)
    const userDataDir = path.join(require('os').tmpdir(), 'pw-airbnb-profile');
    console.log(`  Chrome binary: system Chrome | Profile: ${userDataDir}`);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chrome',
      args: ['--start-maximized'],
      viewport: null,
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
    browser = null;
  } else {
    browser = await chromium.launch({
      headless: false,   // false = you can watch it work; set true for background
      args: [
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    });
  }

  const page = await context.newPage();

  // Mask automation signals
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    let raw;
    if (bedsOnly) {
      raw = loadJSON(CONFIG.outputRaw);
      if (!raw) { console.error('No airbnb-raw.json found. Run without --beds-only first.'); process.exit(1); }
      console.log(`  Loaded ${raw.length} listings from ${CONFIG.outputRaw}`);
    } else {
      raw = await scrapeSearchResults(page);
    }

    if (raw.length === 0) {
      console.log('\n  ⚠ No listings found. Airbnb may be blocking — try --use-real-chrome');
      process.exit(1);
    }

    const beds = await scrapeRoomDetails(page, raw);
    const merged = mergeAndSummarise(raw, beds);

    console.log(`\n✓ Done. Files written:`);
    console.log(`  airbnb-raw.json   — ${raw.length} listings from search`);
    console.log(`  airbnb-beds.json  — ${beds.length} rooms with bed/location detail`);
    console.log(`  airbnb-merged.json — ${merged.length} merged & scored`);

  } finally {
    if (browser) await browser.close();
    else await context.close();
  }
})();
