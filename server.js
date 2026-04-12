const http = require('http');
const https = require('https');

// ─── CONFIG ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.AV_KEY || '';

// ─── CORS HEADERS ────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── FETCH HELPER ────────────────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TheBeast/1.0)',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

// ─── PRICE FETCHERS ──────────────────────────────────────────
async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
    const data = await fetchURL(url);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const prev = data?.chart?.result?.[0]?.meta?.previousClose;
    if (price && price > 0) {
      return { price, prev, source: 'Yahoo' };
    }
  } catch(e) {}
  return null;
}

async function fetchAlphaVantage(ticker) {
  if (!AV_KEY) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${ticker}&interval=1min&outputsize=compact&apikey=${AV_KEY}`;
    const data = await fetchURL(url);
    if (data['Note'] || data['Information']) return null;
    const series = data['Time Series (1min)'];
    if (series) {
      const latest = Object.keys(series)[0];
      const price = parseFloat(series[latest]['4. close']);
      const prev = parseFloat(series[latest]['1. open']);
      if (!isNaN(price) && price > 0) {
        return { price, prev, source: 'AV', time: latest.slice(11, 16) };
      }
    }
  } catch(e) {}
  return null;
}

async function fetchFinnhub(ticker) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=d0eav59r01ql7k2j8o3gd0eav59r01ql7k2j8o40`;
    const data = await fetchURL(url);
    if (data.c && data.c > 0) {
      return { price: data.c, prev: data.pc, source: 'Finnhub' };
    }
  } catch(e) {}
  return null;
}

// ─── MAIN PRICE ENDPOINT ─────────────────────────────────────
async function getPrice(ticker) {
  // Try all sources in order
  const result = 
    await fetchYahoo(ticker) ||
    await fetchAlphaVantage(ticker) ||
    await fetchFinnhub(ticker);
  
  return result || { price: null, source: 'none' };
}

// ─── HTTP SERVER ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'The Beast price server is running' }));
    return;
  }

  // Price endpoint: /price?ticker=SPY
  if (url.pathname === '/price') {
    const ticker = (url.searchParams.get('ticker') || '').toUpperCase().replace(/[^A-Z]/g, '');
    
    if (!ticker) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ticker parameter' }));
      return;
    }

    try {
      const result = await getPrice(ticker);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ticker,
        price: result.price,
        prev: result.prev,
        source: result.source,
        timestamp: new Date().toISOString(),
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Batch prices: /prices?tickers=SPY,NVDA,TSLA
  if (url.pathname === '/prices') {
    const tickerStr = url.searchParams.get('tickers') || '';
    const tickers = tickerStr.split(',').map(t => t.trim().toUpperCase().replace(/[^A-Z]/g, '')).filter(Boolean).slice(0, 10);
    
    if (!tickers.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing tickers parameter' }));
      return;
    }

    try {
      const results = await Promise.all(tickers.map(async ticker => {
        const result = await getPrice(ticker);
        return { ticker, ...result };
      }));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        prices: results,
        timestamp: new Date().toISOString(),
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`The Beast price server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Price:  http://localhost:${PORT}/price?ticker=SPY`);
  console.log(`Prices: http://localhost:${PORT}/prices?tickers=SPY,NVDA,TSLA`);
});
