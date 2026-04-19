const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.AV_KEY || '';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (compatible; TheBeast/1.0)',
        ...options.headers 
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
  });
}

// ─── STOCK PRICES ─────────────────────────────────────────────
async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`;
    const data = await fetchURL(url);
    const meta = data?.chart?.result?.[0]?.meta;
    if(!meta) return null;
    const preMarket = meta.preMarketPrice;
    const postMarket = meta.postMarketPrice;
    const regular = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    let price = regular;
    let priceType = 'close';
    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));
    if(etHour >= 4 && etHour < 10 && preMarket && preMarket > 0){ price = preMarket; priceType = 'premarket'; }
    else if(etHour >= 16 && etHour < 20 && postMarket && postMarket > 0){ price = postMarket; priceType = 'afterhours'; }
    if(price && price > 0) return { price, prev: prevClose, source: 'Yahoo-'+priceType };
  } catch(e) {}
  return null;
}

async function fetchAlphaVantage(ticker) {
  if(!AV_KEY) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${ticker}&interval=1min&outputsize=compact&extended_hours=true&apikey=${AV_KEY}`;
    const data = await fetchURL(url);
    if(data['Note'] || data['Information']) return null;
    const series = data['Time Series (1min)'];
    if(series){
      const latest = Object.keys(series)[0];
      const price = parseFloat(series[latest]['4. close']);
      if(!isNaN(price) && price > 0) return { price, prev: price, source: 'AV-intraday', time: latest.slice(11,16) };
    }
  } catch(e) {}
  return null;
}

// ─── CRYPTO PRICES ────────────────────────────────────────────
async function fetchCoinbasePrice(symbol) {
  try {
    // Remove -USD suffix if present, add it back properly
    const cleanSymbol = symbol.replace(/-USD$/i, '').replace(/-USDT$/i, '');
    const url = `https://api.coinbase.com/v2/prices/${cleanSymbol}-USD/spot`;
    const data = await fetchURL(url);
    const price = parseFloat(data?.data?.amount);
    if(!isNaN(price) && price > 0) {
      return { price, source: 'Coinbase' };
    }
  } catch(e) {}
  return null;
}

async function fetchCryptoYahoo(symbol) {
  try {
    // Yahoo uses different suffix for crypto
    const cleanSymbol = symbol.replace(/-USD$/i, '');
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${cleanSymbol}-USD?interval=1m&range=1d`;
    const data = await fetchURL(url);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if(price && price > 0) return { price, source: 'Yahoo-crypto' };
  } catch(e) {}
  return null;
}

async function getPrice(ticker) {
  const isCrypto = ticker.includes('-USD') || 
    ['BTC','ETH','SOL','XRP','BNB','ADA','AVAX','DOT','MATIC','LINK',
     'UNI','ATOM','PEPE','DOGE','SHIB','WIF','ARB','OP','INJ','SUI',
     'APT','SEI','TIA','JUP','BONK','FLOKI','FET','AGIX','RENDER','WLD','TAO'].includes(ticker);

  if(isCrypto) {
    const cb = await fetchCoinbasePrice(ticker);
    if(cb) return cb;
    const cy = await fetchCryptoYahoo(ticker);
    if(cy) return cy;
    return { price: null, source: 'none' };
  }

  // Stock price
  const av = await fetchAlphaVantage(ticker);
  if(av) return av;
  const yahoo = await fetchYahoo(ticker);
  if(yahoo) return yahoo;
  return { price: null, source: 'none' };
}

// ─── HTTP SERVER ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if(req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if(url.pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok', message:'The Beast server — stocks + crypto', time:new Date().toISOString()}));
    return;
  }

  if(url.pathname === '/price') {
    const ticker = (url.searchParams.get('ticker')||'').toUpperCase().replace(/[^A-Z0-9-]/g,'');
    if(!ticker) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing ticker'})); return; }
    try {
      const result = await getPrice(ticker);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ticker, price:result.price, prev:result.prev, source:result.source, timestamp:new Date().toISOString()}));
    } catch(e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  if(url.pathname === '/prices') {
    const tickerStr = url.searchParams.get('tickers')||'';
    const tickers = tickerStr.split(',').map(t=>t.trim().toUpperCase().replace(/[^A-Z0-9-]/g,'')).filter(Boolean).slice(0,10);
    if(!tickers.length) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing tickers'})); return; }
    try {
      const results = await Promise.all(tickers.map(async ticker => {
        const result = await getPrice(ticker);
        return {ticker, ...result};
      }));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({prices:results, timestamp:new Date().toISOString()}));
    } catch(e) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  res.writeHead(404,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Not found'}));
});

server.listen(PORT, () => {
  console.log(`Beast server running on port ${PORT} — stocks + crypto ready`);
});
