const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const FMP_KEY = process.env.FMP_API_KEY || '';
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

// Allow all origins (your Hostinger domain will call this)
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════
// SIMPLE IN-MEMORY CACHE (survives until server restarts)
// ═══════════════════════════════════════════════════════
const cache = {};
const CACHE_DURATION = {
  profile: 60 * 60 * 1000,       // 1 hour for company profiles
  quote: 5 * 60 * 1000,          // 5 minutes for live quotes
  financials: 24 * 60 * 60 * 1000, // 24 hours for financial statements
  search: 24 * 60 * 60 * 1000,   // 24 hours for search results
};

function getCached(key, type) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.time > (CACHE_DURATION[type] || 300000)) {
    delete cache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data, type) {
  cache[key] = { data, time: Date.now(), type };
}

// ═══════════════════════════════════════════════════════
// HELPER: Call FMP API
// ═══════════════════════════════════════════════════════
async function fmpCall(endpoint) {
  if (!FMP_KEY) throw new Error('FMP_API_KEY not configured');
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${FMP_BASE}${endpoint}${sep}apikey=${FMP_KEY}`;
  console.log(`[FMP] Fetching: ${endpoint}`);
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error(`FMP API error: ${res.status} ${res.statusText}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'ValueLens API',
    hasApiKey: !!FMP_KEY,
    cacheSize: Object.keys(cache).length
  });
});

// ───────── SEARCH STOCKS ─────────
// GET /api/search?q=reliance
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    
    const cacheKey = `search:${q.toLowerCase()}`;
    const cached = getCached(cacheKey, 'search');
    if (cached) return res.json(cached);
    
    const data = await fmpCall(`/search?query=${encodeURIComponent(q)}&limit=20&exchange=NSE`);
    
    const results = (data || []).map(item => ({
      sym: (item.symbol || '').replace('.NS', '').replace('.BO', ''),
      fmpSymbol: item.symbol,
      name: item.name || '',
      sec: item.stockExchange || 'NSE',
      currency: item.currency || 'INR',
    }));
    
    setCache(cacheKey, results, 'search');
    res.json(results);
  } catch (err) {
    console.error('[SEARCH ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────── GET STOCK PROFILE (CMP, Market Cap, PE, Sector, etc) ─────────
// GET /api/stock/RELIANCE
app.get('/api/stock/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const fmpSym = sym.includes('.') ? sym : `${sym}.NS`;
    
    const cacheKey = `profile:${fmpSym}`;
    const cached = getCached(cacheKey, 'profile');
    if (cached) return res.json(cached);
    
    // Fetch profile + quote in parallel
    const [profileData, quoteData] = await Promise.all([
      fmpCall(`/profile/${fmpSym}`),
      fmpCall(`/quote/${fmpSym}`)
    ]);
    
    const p = (profileData && profileData[0]) || {};
    const q = (quoteData && quoteData[0]) || {};
    
    // Market cap from FMP is in the stock's currency (INR for NSE)
    // FMP gives it in full number, we want it in Crores
    const mcapFull = q.marketCap || p.mktCap || 0;
    const mcapCr = mcapFull / 10000000; // Convert to Crores (1 Cr = 10^7)
    
    const sharesOutstanding = p.sharesOutstanding || (mcapFull / (q.price || 1));
    const sharesCr = sharesOutstanding / 10000000;
    
    const result = {
      sym: sym,
      fmpSymbol: fmpSym,
      name: p.companyName || q.name || sym,
      sec: p.sector || 'Unknown',
      industry: p.industry || '',
      cmp: q.price || p.price || 0,
      shr: sharesCr,           // Shares in Crores
      mcapCr: mcapCr,          // Market Cap in Crores
      pe: q.pe || p.lastDiv ? (q.price / (q.eps || 1)) : 0,
      eps: q.eps || 0,
      dayChange: q.change || 0,
      dayChangePct: q.changesPercentage || 0,
      yearHigh: q.yearHigh || 0,
      yearLow: q.yearLow || 0,
      volume: q.volume || 0,
      exchange: p.exchangeShortName || 'NSE',
      description: (p.description || '').slice(0, 300),
      // These need financial statements (separate call)
      pat: null,
      rev: null,
      r3: null, r5: null, p3: null, p5: null,
    };
    
    setCache(cacheKey, result, 'profile');
    res.json(result);
  } catch (err) {
    console.error('[STOCK ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────── GET FINANCIAL STATEMENTS (PAT, Revenue, CAGRs) ─────────
// GET /api/financials/RELIANCE
app.get('/api/financials/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const fmpSym = sym.includes('.') ? sym : `${sym}.NS`;
    
    const cacheKey = `financials:${fmpSym}`;
    const cached = getCached(cacheKey, 'financials');
    if (cached) return res.json(cached);
    
    const data = await fmpCall(`/income-statement/${fmpSym}?limit=10`);
    
    if (!data || !data.length) {
      return res.json({ sym, years: [], pat: 0, rev: 0, r3: 0, r5: 0, p3: 0, p5: 0 });
    }
    
    // FMP returns most recent first
    // Revenue and Net Income are in full currency (INR)
    // Convert to Crores
    const years = data.map(d => ({
      year: d.calendarYear || d.date?.slice(0, 4),
      date: d.date,
      rev: (d.revenue || 0) / 10000000,        // Revenue in Crores
      pat: (d.netIncome || 0) / 10000000,       // PAT in Crores
      ebitda: (d.ebitda || 0) / 10000000,
      grossProfit: (d.grossProfit || 0) / 10000000,
    }));
    
    // Calculate CAGRs
    const calcCAGR = (arr, field, numYears) => {
      if (arr.length < numYears + 1) return null;
      const latest = arr[0][field];
      const older = arr[numYears][field];
      if (!older || older <= 0 || !latest || latest <= 0) return null;
      return (Math.pow(latest / older, 1 / numYears) - 1) * 100;
    };
    
    const result = {
      sym,
      pat: years[0]?.pat || 0,
      rev: years[0]?.rev || 0,
      r3: calcCAGR(years, 'rev', 3),
      r5: calcCAGR(years, 'rev', 5),
      p3: calcCAGR(years, 'pat', 3),
      p5: calcCAGR(years, 'pat', 5),
      years: years.slice(0, 5), // Return last 5 years
    };
    
    setCache(cacheKey, result, 'financials');
    res.json(result);
  } catch (err) {
    console.error('[FINANCIALS ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────── GET FULL STOCK DATA (Profile + Financials combined) ─────────
// GET /api/fullstock/RELIANCE
app.get('/api/fullstock/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const fmpSym = sym.includes('.') ? sym : `${sym}.NS`;
    
    const cacheKey = `fullstock:${fmpSym}`;
    const cached = getCached(cacheKey, 'quote');
    if (cached) return res.json(cached);
    
    // Fetch everything in parallel
    const [profileData, quoteData, incomeData] = await Promise.all([
      fmpCall(`/profile/${fmpSym}`).catch(() => []),
      fmpCall(`/quote/${fmpSym}`).catch(() => []),
      fmpCall(`/income-statement/${fmpSym}?limit=10`).catch(() => []),
    ]);
    
    const p = (profileData && profileData[0]) || {};
    const q = (quoteData && quoteData[0]) || {};
    const income = incomeData || [];
    
    const mcapFull = q.marketCap || p.mktCap || 0;
    const mcapCr = mcapFull / 10000000;
    const sharesCr = (p.sharesOutstanding || (mcapFull / (q.price || 1))) / 10000000;
    
    // Financials
    const years = income.map(d => ({
      year: d.calendarYear || d.date?.slice(0, 4),
      rev: (d.revenue || 0) / 10000000,
      pat: (d.netIncome || 0) / 10000000,
    }));
    
    const calcCAGR = (arr, field, n) => {
      if (arr.length < n + 1) return null;
      const a = arr[0][field], b = arr[n][field];
      if (!b || b <= 0 || !a || a <= 0) return null;
      return Math.round((Math.pow(a / b, 1 / n) - 1) * 1000) / 10;
    };
    
    const result = {
      sym,
      fmpSymbol: fmpSym,
      name: p.companyName || q.name || sym,
      sec: p.sector || 'Unknown',
      industry: p.industry || '',
      cmp: q.price || p.price || 0,
      shr: sharesCr,
      mcapCr,
      pe: q.pe || (q.price && q.eps ? q.price / q.eps : 0),
      eps: q.eps || 0,
      pat: years[0]?.pat || 0,
      rev: years[0]?.rev || 0,
      r3: calcCAGR(years, 'rev', 3),
      r5: calcCAGR(years, 'rev', 5),
      p3: calcCAGR(years, 'pat', 3),
      p5: calcCAGR(years, 'pat', 5),
      dayChange: q.change || 0,
      dayChangePct: q.changesPercentage || 0,
      yearHigh: q.yearHigh || 0,
      yearLow: q.yearLow || 0,
      exchange: p.exchangeShortName || 'NSE',
    };
    
    setCache(cacheKey, result, 'quote');
    res.json(result);
  } catch (err) {
    console.error('[FULLSTOCK ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────── BATCH QUOTES (for screens - get multiple stocks at once) ─────────
// POST /api/batch-quotes  body: { symbols: ["RELIANCE", "TCS", "HDFCBANK"] }
app.post('/api/batch-quotes', async (req, res) => {
  try {
    const symbols = req.body.symbols || [];
    if (!symbols.length) return res.json([]);
    
    // FMP supports comma-separated symbols for quotes
    const fmpSymbols = symbols.map(s => s.includes('.') ? s : `${s}.NS`).join(',');
    
    const cacheKey = `batch:${fmpSymbols}`;
    const cached = getCached(cacheKey, 'quote');
    if (cached) return res.json(cached);
    
    const data = await fmpCall(`/quote/${fmpSymbols}`);
    
    const results = (data || []).map(q => ({
      sym: (q.symbol || '').replace('.NS', '').replace('.BO', ''),
      fmpSymbol: q.symbol,
      name: q.name || '',
      cmp: q.price || 0,
      pe: q.pe || 0,
      mcapCr: (q.marketCap || 0) / 10000000,
      dayChangePct: q.changesPercentage || 0,
      eps: q.eps || 0,
      shr: ((q.sharesOutstanding || 0) / 10000000) || ((q.marketCap || 0) / (q.price || 1) / 10000000),
    }));
    
    setCache(cacheKey, results, 'quote');
    res.json(results);
  } catch (err) {
    console.error('[BATCH ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  🚀 ValueLens API Server Running         ║
║  Port: ${PORT}                              ║
║  FMP Key: ${FMP_KEY ? '✅ Configured' : '❌ MISSING'}               ║
║  Health: http://localhost:${PORT}/            ║
╚═══════════════════════════════════════════╝
  `);
});
