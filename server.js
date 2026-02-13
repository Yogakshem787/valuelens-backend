const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 10000;
const FMP_KEY = process.env.FMP_API_KEY || '';
const FMP_BASE = 'https://financialmodelingprep.com/stable';

app.use(cors());
app.use(express.json());

const cache = {};
const TTL = { profile: 3600000, quote: 300000, financials: 86400000, search: 86400000 };
function cached(key, type) { const e = cache[key]; if (!e) return null; if (Date.now() - e.t > (TTL[type] || 300000)) { delete cache[key]; return null; } return e.d; }
function setCache(key, data, type) { cache[key] = { d: data, t: Date.now() }; }

async function fmp(endpoint, params = {}) {
  if (!FMP_KEY) throw new Error('FMP_API_KEY not set');
  params.apikey = FMP_KEY;
  const qs = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const url = FMP_BASE + '/' + endpoint + '?' + qs;
  console.log('[FMP] ' + endpoint + ' -> ' + Object.keys(params).filter(k => k !== 'apikey').map(k => k + '=' + params[k]).join(', '));
  const res = await fetch(url, { timeout: 15000 });
  const text = await res.text();
  if (!res.ok) { console.error('[FMP ERROR] ' + res.status + ': ' + text.slice(0, 200)); throw new Error('FMP ' + res.status); }
  try { return JSON.parse(text); } catch (e) { console.error('[FMP PARSE] ' + text.slice(0, 200)); throw e; }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ValueLens API v2', hasApiKey: !!FMP_KEY, cache: Object.keys(cache).length });
});

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const ck = 's:' + q.toLowerCase();
    const c = cached(ck, 'search');
    if (c) return res.json(c);
    const data = await fmp('search-name', { query: q });
    const results = (Array.isArray(data) ? data : [])
      .filter(item => { const s = item.symbol || ''; return s.endsWith('.NS') || s.endsWith('.BO') || item.exchangeShortName === 'NSE'; })
      .slice(0, 15)
      .map(item => ({ sym: (item.symbol || '').replace('.NS', '').replace('.BO', ''), fmpSymbol: item.symbol, name: item.name || '', sec: item.exchangeShortName || 'NSE' }));
    setCache(ck, results, 'search');
    res.json(results);
  } catch (err) { console.error('[SEARCH ERR]', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/fullstock/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const fmpSym = sym.includes('.') ? sym : sym + '.NS';
    const ck = 'fs:' + fmpSym;
    const c = cached(ck, 'quote');
    if (c) return res.json(c);

    const [profileData, quoteData, incomeData] = await Promise.all([
      fmp('profile', { symbol: fmpSym }).catch(e => { console.error('[PROFILE ERR]', e.message); return []; }),
      fmp('quote', { symbol: fmpSym }).catch(e => { console.error('[QUOTE ERR]', e.message); return []; }),
      fmp('income-statement', { symbol: fmpSym, limit: 10 }).catch(e => { console.error('[INCOME ERR]', e.message); return []; }),
    ]);

    console.log('[DEBUG] Profile keys:', Object.keys(Array.isArray(profileData) ? (profileData[0] || {}) : (profileData || {})).slice(0, 10));
    console.log('[DEBUG] Quote keys:', Object.keys(Array.isArray(quoteData) ? (quoteData[0] || {}) : (quoteData || {})).slice(0, 10));
    console.log('[DEBUG] Income years:', Array.isArray(incomeData) ? incomeData.length : 0);

    const p = Array.isArray(profileData) ? (profileData[0] || {}) : (profileData || {});
    const q = Array.isArray(quoteData) ? (quoteData[0] || {}) : (quoteData || {});
    const income = Array.isArray(incomeData) ? incomeData : [];

    const mcapFull = q.marketCap || p.mktCap || 0;
    const mcapCr = mcapFull / 1e7;
    const price = q.price || p.price || 0;
    const sharesFull = p.sharesOutstanding || (price > 0 ? mcapFull / price : 0);
    const sharesCr = sharesFull / 1e7;

    const years = income.map(d => ({ year: d.calendarYear || (d.date || '').slice(0, 4), rev: (d.revenue || 0) / 1e7, pat: (d.netIncome || 0) / 1e7 }));
    const calcCagr = (arr, f, n) => { if (arr.length < n + 1) return null; const a = arr[0][f], b = arr[n][f]; if (!b || b <= 0 || !a || a <= 0) return null; return Math.round((Math.pow(a / b, 1 / n) - 1) * 1000) / 10; };

    const result = {
      sym, fmpSymbol: fmpSym,
      name: p.companyName || q.name || sym,
      sec: p.sector || 'Unknown',
      industry: p.industry || '',
      cmp: price, shr: sharesCr, mcapCr,
      pe: q.pe || (price > 0 && q.eps > 0 ? price / q.eps : 0),
      eps: q.eps || 0,
      pat: years[0] ? years[0].pat : 0,
      rev: years[0] ? years[0].rev : 0,
      r3: calcCagr(years, 'rev', 3), r5: calcCagr(years, 'rev', 5),
      p3: calcCagr(years, 'pat', 3), p5: calcCagr(years, 'pat', 5),
      dayChange: q.change || 0, dayChangePct: q.changesPercentage || 0,
      yearHigh: q.yearHigh || 0, yearLow: q.yearLow || 0,
      exchange: p.exchangeShortName || 'NSE',
    };

    setCache(ck, result, 'quote');
    res.json(result);
  } catch (err) { console.error('[FULLSTOCK ERR]', err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/batch-quotes', async (req, res) => {
  try {
    const symbols = req.body.symbols || [];
    if (!symbols.length) return res.json([]);
    const fmpSym = symbols.map(s => s.includes('.') ? s : s + '.NS').join(',');
    const ck = 'bq:' + fmpSym;
    const c = cached(ck, 'quote');
    if (c) return res.json(c);
    const data = await fmp('quote', { symbol: fmpSym });
    const results = (Array.isArray(data) ? data : []).map(q => ({
      sym: (q.symbol || '').replace('.NS', '').replace('.BO', ''),
      name: q.name || '', cmp: q.price || 0, pe: q.pe || 0,
      mcapCr: (q.marketCap || 0) / 1e7, dayChangePct: q.changesPercentage || 0,
    }));
    setCache(ck, results, 'quote');
    res.json(results);
  } catch (err) { console.error('[BATCH ERR]', err.message); res.status(500).json({ error: err.message }); }
});

app.get('/api/test', async (req, res) => {
  try {
    const data = await fmp('quote', { symbol: 'AAPL' });
    res.json({ status: 'ok', fmpWorking: true, samplePrice: (Array.isArray(data) ? data[0] : data)?.price, keyPrefix: FMP_KEY.slice(0, 5) });
  } catch (err) {
    res.json({ status: 'error', fmpWorking: false, error: err.message, keyPrefix: FMP_KEY.slice(0, 5) });
  }
});

app.listen(PORT, () => {
  console.log('\n ValueLens API v2 on port ' + PORT);
  console.log('   FMP Key: ' + (FMP_KEY ? 'YES (' + FMP_KEY.slice(0, 5) + '...)' : 'MISSING'));
  console.log('   Base: ' + FMP_BASE + '\n');
});
