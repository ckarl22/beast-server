const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.AV_KEY || '';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function fetchURL(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheBeast/1.0)', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

// Crypto symbols list
const CRYPTO_SYMBOLS = new Set([
  'BTC','ETH','SOL','XRP','BNB','ADA','AVAX','DOT','MATIC','LINK',
  'UNI','ATOM','PEPE','DOGE','SHIB','WIF','ARB','OP','INJ','SUI',
  'APT','SEI','TIA','JUP','BONK','FLOKI','FET','AGIX','RENDER',
  'WLD','TAO','HYPE','BRETT','MOG','AAVE','CRV','MKR','SNX',
  'LTC','BCH','ETC','NEAR','FTM','ALGO','VET','SAND','MANA',
]);

function isCryptoTicker(ticker) {
  const clean = ticker.replace(/-USD$/i,'').replace(/-USDT$/i,'');
  return CRYPTO_SYMBOLS.has(clean);
}

// ─── COINBASE PUBLIC API (no auth needed for prices) ──────────
async function fetchCoinbase(symbol) {
  try {
    const clean = symbol.replace(/-USD$/i,'').replace(/-USDT$/i,'');
    const result = await fetchURL(`https://api.coinbase.com/v2/prices/${clean}-USD/spot`);
    const price = parseFloat(result.body?.data?.amount);
    if(!isNaN(price) && price > 0) {
      return { price, source: 'Coinbase' };
    }
  } catch(e) {}
  return null;
}

// ─── COINGECKO (backup crypto) ────────────────────────────────
async function fetchCoinGecko(symbol) {
  try {
    const clean = symbol.replace(/-USD$/i,'').toLowerCase();
    // Map symbols to CoinGecko IDs
    const idMap = {
      'btc':'bitcoin','eth':'ethereum','sol':'solana','xrp':'ripple',
      'bnb':'binancecoin','ada':'cardano','avax':'avalanche-2','dot':'polkadot',
      'matic':'matic-network','link':'chainlink','uni':'uniswap','atom':'cosmos',
      'doge':'dogecoin','shib':'shiba-inu','arb':'arbitrum','op':'optimism',
      'pepe':'pepe','wif':'dogwifcoin','bonk':'bonk','fet':'fetch-ai',
      'render':'render-token','wld':'worldcoin-wld','tao':'bittensor',
    };
    const id = idMap[clean] || clean;
    const result = await fetchURL(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const price = result.body?.[id]?.usd;
    if(price && price > 0) return { price, source: 'CoinGecko' };
  } catch(e) {}
  return null;
}

// ─── YAHOO FINANCE (stocks only) ─────────────────────────────
async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`;
    const result = await fetchURL(url);
    const meta = result.body?.chart?.result?.[0]?.meta;
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
    const result = await fetchURL(url);
    const d = result.body;
    if(d['Note'] || d['Information']) return null;
    const series = d['Time Series (1min)'];
    if(series) {
      const latest = Object.keys(series)[0];
      const price = parseFloat(series[latest]['4. close']);
      if(!isNaN(price) && price > 0) return { price, prev: price, source: 'AV-intraday' };
    }
  } catch(e) {}
  return null;
}

// ─── MAIN PRICE ROUTER ────────────────────────────────────────
async function getPrice(ticker) {
  if(isCryptoTicker(ticker)) {
    // Crypto: Coinbase first, CoinGecko backup
    const cb = await fetchCoinbase(ticker);
    if(cb) return cb;
    const cg = await fetchCoinGecko(ticker);
    if(cg) return cg;
    return { price: null, source: 'none' };
  } else {
    // Stocks: AV first, Yahoo backup
    const av = await fetchAlphaVantage(ticker);
    if(av) return av;
    const yh = await fetchYahoo(ticker);
    if(yh) return yh;
    return { price: null, source: 'none' };
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if(req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if(url.pathname === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok', message:'Beast server v3 — stocks + crypto', time:new Date().toISOString()}));
    return;
  }

  if(url.pathname === '/price') {
    const ticker = (url.searchParams.get('ticker')||'').toUpperCase().replace(/[^A-Z0-9-]/g,'');
    if(!ticker) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing ticker'})); return; }
    try {
      const result = await getPrice(ticker);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ticker, price:result.price, prev:result.prev||null, source:result.source, timestamp:new Date().toISOString()}));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
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
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({prices:results, timestamp:new Date().toISOString()}));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  res.writeHead(404, {'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Not found'}));
});

server.listen(PORT, () => {
  console.log(`Beast server v3 on port ${PORT} — Coinbase + CoinGecko + Yahoo + AV`);
});
