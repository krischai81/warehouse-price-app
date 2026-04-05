import express from "express";
import cors    from "cors";
import dotenv  from "dotenv";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────
const APIFY_TOKEN      = process.env.APIFY_TOKEN;
const COSTCO_WAREHOUSE = process.env.COSTCO_WAREHOUSE_ID || "1450"; // Melbourne FL
const SAMS_CLUB_ID     = process.env.SAMS_CLUB_ID        || "8141"; // Melbourne FL

const APIFY_BASE  = "https://api.apify.com/v2";
const SAMS_ACTOR  = "easyapi~sam-s-club-product-scraper";
const COSTCO_ACTOR = "parseforge~costco-scraper";

// ── Costco: hit their own internal search API first (free, no key needed) ─
// This is what costco.com itself calls. whloc={warehouse}-wh returns true
// floor prices for that warehouse — not the marked-up online prices.
async function searchCostco(item) {
  const params = new URLSearchParams({
    q:      item,
    whloc:  `${COSTCO_WAREHOUSE}-wh`,
    locale: "en-US",
    lang:   "en-US",
    start:  "0",
    sz:     "5",
  });

  try {
    const res = await fetch(
      `https://www.costco.com/SearchClearanceSavings?${params}`,
      {
        signal: AbortSignal.timeout(12000),
        headers: {
          "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept":          "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer":         "https://www.costco.com/",
          "Origin":          "https://www.costco.com",
        },
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const docs = body?.response?.docs ?? body?.docs ?? [];
    if (!docs.length) throw new Error("no results");

    // Prefer items actually stocked in this warehouse
    const inStore = docs.filter(d =>
      d.item_location_pricing_listPrice != null &&
      !d.item_program_eligibility?.includes("ShipIt")
    );
    const doc = inStore[0] ?? docs[0];

    const price = extractPrice(
      doc.item_location_pricing_listPrice ??
      doc.price                           ??
      doc.item_sales_price
    );
    const name = (doc.name ?? doc.item_name ?? item).slice(0, 80);
    const unit = doc.item_product_size ?? extractUnit(name);

    return { price, name, unit, found: price != null, inWarehouse: inStore.length > 0, source: "direct" };

  } catch (err) {
    console.warn(`Costco direct API blocked/failed for "${item}" (${err.message}) — using Apify fallback`);
    return searchCostcoViaApify(item);
  }
}

// ── Costco: Apify fallback when direct API is blocked ────────────────────
async function searchCostcoViaApify(item) {
  if (!APIFY_TOKEN) return empty(item, "direct API blocked and no Apify token");
  try {
    const dataset = await runApifyActor(COSTCO_ACTOR, { search: item, maxItems: 3 });
    const first   = dataset?.[0];
    if (!first) return empty(item, "no Apify results");

    const price = extractPrice(first.price ?? first.salePrice ?? first.listing_price);
    return {
      price, found: price != null,
      name: (first.name ?? first.title ?? item).slice(0, 80),
      unit: first.size ?? extractUnit(first.name ?? ""),
      inWarehouse: null,  // unknown via Apify (online prices)
      source: "apify_fallback",
    };
  } catch (err) {
    console.error(`Costco Apify fallback failed: ${err.message}`);
    return empty(item, err.message);
  }
}

// ── Sam's Club: Apify (online price = in-club price, accurate) ───────────
async function searchSamsClub(item) {
  if (!APIFY_TOKEN) return empty(item, "APIFY_TOKEN not set");
  try {
    const dataset = await runApifyActor(SAMS_ACTOR, {
      searchKeyword: item,
      club_id:       SAMS_CLUB_ID,
      maxItems:      3,
    });
    const first = dataset?.[0];
    if (!first) return empty(item, "no results");

    const price = extractPrice(first.price ?? first.salePrice ?? first.priceAmount);
    return {
      price, found: price != null,
      name: (first.name ?? first.title ?? item).slice(0, 80),
      unit: first.size ?? extractUnit(first.name ?? ""),
      inWarehouse: true,
      source: "apify",
    };
  } catch (err) {
    console.error(`Sam's Club error: ${err.message}`);
    return empty(item, err.message);
  }
}

// ── Apify helper ──────────────────────────────────────────────────────────
async function runApifyActor(actorId, input) {
  const run = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}&waitForFinish=90`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
  );
  if (!run.ok) throw new Error(`Actor start failed: ${run.status}`);
  const { data } = await run.json();
  const items = await fetch(
    `${APIFY_BASE}/datasets/${data.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=5`
  );
  return items.ok ? items.json() : [];
}

// ── Shared helpers ────────────────────────────────────────────────────────
function extractPrice(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && raw > 0) return raw;
  const m = String(raw).replace(/,/g, "").match(/\$?([\d]+\.?\d*)/);
  const n = m ? parseFloat(m[1]) : null;
  return n > 0 ? n : null;
}

function extractUnit(name) {
  const m = name.match(/(\d+[\s\-]?(ct|pk|oz|fl\.?\s*oz|lb|lbs|count|pack|kg|g|L|ml)\b[^,]*)/i);
  return m ? m[0].trim().slice(0, 40) : null;
}

function empty(item, reason) {
  return { price: null, name: item, unit: null, found: false, inWarehouse: null, reason };
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status:           "ok",
  apify_token:      !!APIFY_TOKEN,
  costco_warehouse: COSTCO_WAREHOUSE,
  sams_club_id:     SAMS_CLUB_ID,
  timestamp:        new Date().toISOString(),
}));

app.get("/stores", (_req, res) => res.json({
  costco: {
    warehouse_id: COSTCO_WAREHOUSE,
    name:    "Costco Viera West",
    address: "4305 Pineda Causeway, Melbourne FL 32940",
    note:    "Tries Costco's internal API first (true warehouse prices) — falls back to Apify if blocked",
  },
  samsclub: {
    club_id: SAMS_CLUB_ID,
    name:    "Sam's Club Melbourne",
    address: "4255 W New Haven Ave, Melbourne FL 32904",
    note:    "Online prices via Apify — match in-club prices exactly",
  },
}));

app.post("/compare", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: "items must be a non-empty array." });
  if (items.length > 20)
    return res.status(400).json({ error: "Max 20 items per request." });

  try {
    const rows = await Promise.all(items.map(async (item) => {
      const [costco, sams] = await Promise.all([searchCostco(item), searchSamsClub(item)]);
      const cp = costco.price, sp = sams.price;

      let winner = "not_found", savings = null;
      if (cp != null && sp != null) {
        if (cp < sp)      { winner = "costco";   savings = +(sp - cp).toFixed(2); }
        else if (sp < cp) { winner = "samsclub"; savings = +(cp - sp).toFixed(2); }
        else              { winner = "tie";      savings = 0; }
      } else if (cp != null) { winner = "costco_only"; }
        else if (sp != null) { winner = "samsclub_only"; }

      return {
        item,
        costco_price:        cp,
        costco_name:         costco.name,
        costco_unit:         costco.unit,
        costco_in_warehouse: costco.inWarehouse,
        costco_source:       costco.source,
        samsclub_price:      sp,
        samsclub_name:       sams.name,
        samsclub_unit:       sams.unit,
        winner,
        savings,
      };
    }));

    const comparable     = rows.filter(r => r.costco_price != null && r.samsclub_price != null);
    const costco_total   = +rows.reduce((s, r) => s + (r.costco_price   ?? 0), 0).toFixed(2);
    const samsclub_total = +rows.reduce((s, r) => s + (r.samsclub_price ?? 0), 0).toFixed(2);

    res.json({
      results: rows,
      stores:  { costco: { warehouse_id: COSTCO_WAREHOUSE }, samsclub: { club_id: SAMS_CLUB_ID } },
      summary: {
        costco_total, samsclub_total,
        costco_wins:    rows.filter(r => r.winner === "costco").length,
        samsclub_wins:  rows.filter(r => r.winner === "samsclub").length,
        ties:           rows.filter(r => r.winner === "tie").length,
        items_compared: comparable.length,
        overall_winner: costco_total > 0 && samsclub_total > 0
          ? (costco_total <= samsclub_total ? "costco" : "samsclub")
          : "insufficient_data",
        total_savings: +Math.abs(costco_total - samsclub_total).toFixed(2),
      },
    });
  } catch (err) {
    console.error("Compare error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n Warehouse Price API  →  http://localhost:${PORT}`);
  console.log(` Apify token:           ${APIFY_TOKEN ? "✓" : "✗ MISSING"}`);
  console.log(` Costco warehouse:      #${COSTCO_WAREHOUSE}  →  direct API + Apify fallback`);
  console.log(` Sam's Club:            #${SAMS_CLUB_ID}    →  Apify\n`);
});
