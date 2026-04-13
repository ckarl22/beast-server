const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.AV_KEY || '';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheBeast/1.0)' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`;
    const data = await fetchURL(url);
    const meta = data?.chart?.result?.[0]?.meta;
    if(!meta) return null;

    // Use the most current price available
    // preMarketPrice > regularMarketPrice > previousClose
    const preMarket = meta.preMarketPrice;
    const postMarket = meta.postMarketPrice;
    const regular = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;

    // Pick the most current price
    let price = regular;
    let priceType = 'close';

    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));

    // Pre-market hours 4am-9:30am ET
    if(etHour >= 4 && etHour < 10 && preMarket && preMarket > 0){
      price = preMarket;
      priceType = 'premarket';
    }
    // After-hours 4pm-8pm ET
    else if(etHour >= 16 && etHour < 20 && postMarket && postMarket > 0){
      price = postMarket;
      priceType = 'afterhours';
    }

    if(price && price > 0){
      return { price, prev: prevClose, source: 'Yahoo-'+priceType };
    }
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
      if(!isNaN(price) && price > 0){
        return { price, prev: price, source: 'AV-intraday', time: latest.slice(11,16) };
      }
    }
  } catch(e) {}
  return null;
}

async function getPrice(ticker) {
  // Try AV intraday first (most accurate minute data with extended hours)
  const av = await fetchAlphaVantage(ticker);
  if(av) return av;

  // Fall back to Yahoo
  const yahoo = await fetchYahoo(ticker);
  if(yahoo) return yahoo;

  return { price: null, source: 'none' };
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if(req.method === 'OPTIONS'){ res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if(url.pathname === '/health'){
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',message:'The Beast price server running',time:new Date().toISOString()}));
    return;
  }

  if(url.pathname === '/price'){
    const ticker = (url.searchParams.get('ticker')||'').toUpperCase().replace(/[^A-Z]/g,'');
    if(!ticker){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing ticker'})); return; }
    try {
      const result = await getPrice(ticker);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ticker, price:result.price, prev:result.prev, source:result.source, timestamp:new Date().toISOString()}));
    } catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  if(url.pathname === '/prices'){
    const tickerStr = url.searchParams.get('tickers')||'';
    const tickers = tickerStr.split(',').map(t=>t.trim().toUpperCase().replace(/[^A-Z]/g,'')).filter(Boolean).slice(0,10);
    if(!tickers.length){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing tickers'})); return; }
    try {
      const results = await Promise.all(tickers.map(async ticker => {
        const result = await getPrice(ticker);
        return {ticker, ...result};
      }));
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({prices:results, timestamp:new Date().toISOString()}));
    } catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  res.writeHead(404,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Not found'}));
});

server.listen(PORT, () => {
  console.log(`Beast price server on port ${PORT}`);
});
