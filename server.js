import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const COSTCO_WAREHOUSE = process.env.COSTCO_WAREHOUSE_ID || "1450";
const SAMS_CLUB_ID = process.env.SAMS_CLUB_ID || "8141";

const APIFY_BASE = "https://api.apify.com/v2";
const SAMS_ACTOR = "easyapi~sam-s-club-product-scraper";
const COSTCO_ACTOR = "parseforge~costco-scraper";

// ── Safe JSON fetch — never throws on HTML responses ─────────────────────
async function safeJsonFetch(url, options = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), ...options });
  const contentType = res.headers.get("content-type") ?? "";

  // If we got HTML back (e.g. Akamai block page), don't try to parse it
  if (!contentType.includes("json")) {
    throw new Error(`Non-JSON response (${res.status}): ${contentType}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

// ── Costco: internal search API (free, no key, warehouse-specific prices) ─
async function searchCostco(item) {
  const params = new URLSearchParams({
    q: item,
    whloc: `${COSTCO_WAREHOUSE}-wh`,
    locale: "en-US",
    lang: "en-US",
    start: "0",
    sz: "5",
  });

  try {
    const body = await safeJsonFetch(
      `https://www.costco.com/SearchClearanceSavings?${params}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.costco.com/",
        },
      }
    );

    const docs = body?.response?.docs ?? body?.docs ?? [];
    if (!docs.length) throw new Error("no results");

    const inStore = docs.filter(d =>
      d.item_location_pricing_listPrice != null &&
      !d.item_program_eligibility?.includes("ShipIt")
    );
    const doc = inStore[0] ?? docs[0];
    const price = extractPrice(
      doc.item_location_pricing_listPrice ?? doc.price ?? doc.item_sales_price
    );

    return {
      price, found: price != null,
      name: (doc.name ?? doc.item_name ?? item).slice(0, 80),
      unit: doc.item_product_size ?? extractUnit(doc.name ?? item),
      inWarehouse: inStore.length > 0,
      source: "direct",
    };

  } catch (err) {
    console.warn(`Costco direct blocked for "${item}": ${err.message} — trying Apify`);
    return searchCostcoApify(item);
  }
}

// ── Costco: Apify fallback ────────────────────────────────────────────────
async function searchCostcoApify(item) {
  if (!APIFY_TOKEN) return empty(item, "no Apify token");
  try {
    const dataset = await runActor(COSTCO_ACTOR, { searchQuery: item, maxItems: 3 });
    const first = dataset?.[0];
    if (!first) return empty(item, "no results from Apify");

    const price = extractPrice(first.price ?? first.salePrice ?? first.listing_price);
    return {
      price, found: price != null,
      name: (first.name ?? first.title ?? item).slice(0, 80),
      unit: first.size ?? extractUnit(first.name ?? ""),
      inWarehouse: null,
      source: "apify",
    };
  } catch (err) {
    console.error(`Costco Apify failed for "${item}": ${err.message}`);
    return empty(item, err.message);
  }
}

// ── Sam's Club: Apify ─────────────────────────────────────────────────────
async function searchSamsClub(item) {
  if (!APIFY_TOKEN) return empty(item, "no Apify token");
  try {
    const dataset = await runActor(SAMS_ACTOR, {
      searchUrls: [`https://www.samsclub.com/s/${encodeURIComponent(item)}`],
      club_id: SAMS_CLUB_ID,
      maxItems: 3,
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
    console.error(`Sam's Club Apify failed for "${item}": ${err.message}`);
    return empty(item, err.message);
  }
}

// ── Apify runner — 55s timeout (safely under Railway's 60s limit) ─────────
async function runActor(actorId, input) {
  const startRes = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}&waitForFinish=55`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
    }
  );
  if (!startRes.ok) throw new Error(`Apify start failed: ${startRes.status}`);

  const { data } = await startRes.json();
  if (!data?.defaultDatasetId) throw new Error("No dataset ID from Apify");

  const dataRes = await fetch(
    `${APIFY_BASE}/datasets/${data.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=5`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!dataRes.ok) throw new Error(`Apify dataset fetch failed: ${dataRes.status}`);
  return dataRes.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function extractPrice(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && raw > 0) return raw;
  const m = String(raw).replace(/,/g, "").match(/\$?([\d]+\.?\d*)/);
  const n = m ? parseFloat(m[1]) : null;
  return n > 0 ? n : null;
}

function extractUnit(name = "") {
  const m = name.match(/(\d+[\s\-]?(ct|pk|oz|fl\.?\s*oz|lb|lbs|count|pack|kg|g|L|ml)\b[^,]*)/i);
  return m ? m[0].trim().slice(0, 40) : null;
}

function empty(item, reason) {
  return { price: null, name: item, unit: null, found: false, inWarehouse: null, reason };
}

// ── Routes ────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", message: "Warehouse Price API" }));

app.get("/health", (_req, res) => res.json({
  status: "ok",
  apify_token: !!APIFY_TOKEN,
  costco_warehouse: COSTCO_WAREHOUSE,
  sams_club_id: SAMS_CLUB_ID,
  timestamp: new Date().toISOString(),
}));

app.get("/stores", (_req, res) => res.json({
  costco: {
    warehouse_id: COSTCO_WAREHOUSE,
    name: "Costco Viera West",
    address: "4305 Pineda Causeway, Melbourne FL 32940",
    note: "Internal API (warehouse prices) with Apify fallback",
  },
  samsclub: {
    club_id: SAMS_CLUB_ID,
    name: "Sam's Club Melbourne",
    address: "4255 W New Haven Ave, Melbourne FL 32904",
    note: "Apify — online prices match in-club prices",
  },
}));

app.post("/compare", async (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: "items must be a non-empty array." });
  if (items.length > 20)
    return res.status(400).json({ error: "Max 20 items per request." });

  try {
    const rows = await Promise.all(items.map(async (item) => {
      const [costco, sams] = await Promise.all([
        searchCostco(item),
        searchSamsClub(item),
      ]);

      const cp = costco.price, sp = sams.price;
      let winner = "not_found", savings = null;
      if (cp != null && sp != null) {
        if (cp < sp) { winner = "costco"; savings = +(sp - cp).toFixed(2); }
        else if (sp < cp) { winner = "samsclub"; savings = +(cp - sp).toFixed(2); }
        else { winner = "tie"; savings = 0; }
      } else if (cp != null) { winner = "costco_only"; }
      else if (sp != null) { winner = "samsclub_only"; }

      return {
        item,
        costco_price: cp,
        costco_name: costco.name,
        costco_unit: costco.unit,
        costco_in_warehouse: costco.inWarehouse,
        costco_source: costco.source,
        samsclub_price: sp,
        samsclub_name: sams.name,
        samsclub_unit: sams.unit,
        winner,
        savings,
      };
    }));

    const comparable = rows.filter(r => r.costco_price != null && r.samsclub_price != null);
    const costco_total = +rows.reduce((s, r) => s + (r.costco_price ?? 0), 0).toFixed(2);
    const samsclub_total = +rows.reduce((s, r) => s + (r.samsclub_price ?? 0), 0).toFixed(2);

    res.json({
      results: rows,
      stores: { costco: { warehouse_id: COSTCO_WAREHOUSE }, samsclub: { club_id: SAMS_CLUB_ID } },
      summary: {
        costco_total,
        samsclub_total,
        costco_wins: rows.filter(r => r.winner === "costco").length,
        samsclub_wins: rows.filter(r => r.winner === "samsclub").length,
        ties: rows.filter(r => r.winner === "tie").length,
        items_compared: comparable.length,
        overall_winner: costco_total > 0 && samsclub_total > 0
          ? (costco_total <= samsclub_total ? "costco" : "samsclub")
          : "insufficient_data",
        total_savings: +Math.abs(costco_total - samsclub_total).toFixed(2),
      },
    });

  } catch (err) {
    console.error("Compare route error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler — always returns JSON, never HTML ────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n Warehouse Price API  →  http://localhost:${PORT}`);
  console.log(` Apify token:      ${APIFY_TOKEN ? "✓" : "✗ MISSING — set in Railway Variables"}`);
  console.log(` Costco warehouse: #${COSTCO_WAREHOUSE}`);
  console.log(` Sam's Club:       #${SAMS_CLUB_ID}\n`);
});
