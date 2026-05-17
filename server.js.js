const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.AV_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';

// In-memory signal queue (persists while server runs)
let signalQueue = [];
let isScanning = false;
let scanInterval = null;
let scanMode = 'STOPPED'; // STOPPED, CRYPTO, STOCKS

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

// Coinbase verified altcoins only
const CRYPTO_SYMBOLS = new Set([
  'BTC','ETH','SOL','XRP','BNB','ADA','AVAX','DOT','MATIC','LINK',
  'UNI','ATOM','PEPE','DOGE','SHIB','WIF','ARB','OP','INJ','SUI',
  'APT','SEI','TIA','JUP','BONK','FLOKI','FET','AGIX','RENDER',
  'WLD','TAO','AAVE','CRV','MKR','SNX','DYDX','ENA','PENDLE',
  'IMX','RON','ONDO','ZRO','EIGEN','PYTH','GRT','TURBO','POPCAT',
  'STRK','LTC','BCH','ETC','NEAR','ALGO',
]);

function isCrypto(ticker) {
  return CRYPTO_SYMBOLS.has(ticker.replace(/-USD$/i,''));
}

async function fetchCoinbase(symbol) {
  try {
    const clean = symbol.replace(/-USD$/i,'');
    const result = await fetchURL(`https://api.coinbase.com/v2/prices/${clean}-USD/spot`);
    const price = parseFloat(result.body?.data?.amount);
    if(!isNaN(price) && price > 0) return { price, source: 'Coinbase' };
  } catch(e) {}
  return null;
}

async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d&includePrePost=true`;
    const result = await fetchURL(url);
    const meta = result.body?.chart?.result?.[0]?.meta;
    if(!meta) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose;
    if(price && price > 0) return { price, prev, source: 'Yahoo' };
  } catch(e) {}
  return null;
}

async function getPrice(ticker) {
  if(isCrypto(ticker)) {
    const cb = await fetchCoinbase(ticker);
    if(cb) return cb;
  } else {
    const yh = await fetchYahoo(ticker);
    if(yh) return yh;
  }
  return { price: null, source: 'none' };
}

// Scan crypto news and generate signal via Anthropic
async function runServerScan() {
  if(isScanning || !ANTHROPIC_KEY) return;
  isScanning = true;

  const sources = [
    'CoinDesk crypto altcoin breaking news today',
    'Cointelegraph cryptocurrency altcoin news today',
    'CryptoSlate altcoin DeFi breaking news today',
  ];
  const src = sources[Math.floor(Math.random()*sources.length)];

  try {
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        system: `You are an altcoin hunter. Find explosive crypto opportunities. Output EXACTLY 4 lines:
1. SYMBOL (Coinbase-listed crypto only: BTC ETH SOL XRP PEPE WIF BONK DOGE SHIB ARB OP SUI APT INJ TIA FET RENDER AAVE UNI DYDX ENA etc)
2. LONG or SHORT
3. EDGE (0.10 to 0.50)
4. HEADLINE (max 80 chars)
Nothing else. 4 lines only.`,
        messages: [{ role: 'user', content: `Search ${src} for the most explosive altcoin opportunity right now. 4 lines only.` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      });

      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if(response.error) {
      console.log('API error:', response.error.message);
      isScanning = false;
      return;
    }

    const text = response.content?.map(b => b.type === 'text' ? b.text : '').join('').trim();
    const lines = text.split('\n').filter(l => l.trim()).map(l => l.replace(/^\d+\.?\s*/, '').trim());

    let symbol = (lines[0]||'BTC').toUpperCase().replace(/[^A-Z]/g,'').slice(0,10);
    if(!CRYPTO_SYMBOLS.has(symbol)) symbol = 'ETH';

    const direction = (lines[1]||'LONG').toUpperCase().includes('SHORT') ? 'SHORT' : 'LONG';
    let edge = parseFloat(lines[2]||'0.15')||0.15;
    if(edge > 1) edge = edge/100;
    edge = Math.min(Math.max(edge, 0.05), 0.50);
    const headline = (lines[3]||'Crypto signal').slice(0, 120);

    // Fetch live price
    const priceData = await fetchCoinbase(symbol);
    const price = priceData?.price;

    if(!price || price <= 0) {
      console.log(`No valid price for ${symbol} — signal skipped`);
      isScanning = false;
      return;
    }

    const signal = {
      id: Date.now(),
      ticker: symbol,
      direction,
      edge: +edge.toFixed(3),
      headline,
      price,
      source: src.split(' ')[0],
      timestamp: new Date().toISOString(),
      timeDisplay: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
    };

    signalQueue.push(signal);
    // Keep only last 50 signals
    if(signalQueue.length > 50) signalQueue = signalQueue.slice(-50);
    console.log(`Signal: ${symbol} ${direction} | Edge: ${Math.round(edge*100)}% | $${price} | ${headline.slice(0,40)}`);

  } catch(e) {
    console.log('Scan error:', e.message);
  }

  isScanning = false;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if(req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if(url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      message: 'Beast server v4 — stocks + crypto + server scanner',
      scanMode,
      queuedSignals: signalQueue.length,
      time: new Date().toISOString()
    }));
    return;
  }

  // Price endpoint
  if(url.pathname === '/price') {
    const ticker = (url.searchParams.get('ticker')||'').toUpperCase().replace(/[^A-Z0-9-]/g,'');
    if(!ticker) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing ticker'})); return; }
    try {
      const result = await getPrice(ticker);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ticker, price: result.price, prev: result.prev||null, source: result.source, timestamp: new Date().toISOString() }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Batch prices
  if(url.pathname === '/prices') {
    const tickerStr = url.searchParams.get('tickers')||'';
    const tickers = tickerStr.split(',').map(t=>t.trim().toUpperCase().replace(/[^A-Z0-9-]/g,'')).filter(Boolean).slice(0,10);
    if(!tickers.length) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Missing tickers'})); return; }
    try {
      const results = await Promise.all(tickers.map(async ticker => {
        const result = await getPrice(ticker);
        return { ticker, ...result };
      }));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ prices: results, timestamp: new Date().toISOString() }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Start server-side scanning
  if(url.pathname === '/scan/start') {
    const mode = url.searchParams.get('mode')||'CRYPTO';
    scanMode = mode;
    if(scanInterval) clearInterval(scanInterval);
    // Scan every 90 seconds
    scanInterval = setInterval(runServerScan, 90*1000);
    // Run first scan immediately
    runServerScan();
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status: 'scanning', mode, interval: '90s' }));
    console.log(`Server scanning started — ${mode} mode`);
    return;
  }

  // Stop server-side scanning
  if(url.pathname === '/scan/stop') {
    if(scanInterval) clearInterval(scanInterval);
    scanInterval = null;
    scanMode = 'STOPPED';
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status: 'stopped' }));
    return;
  }

  // Get queued signals
  if(url.pathname === '/signals') {
    const since = parseInt(url.searchParams.get('since')||'0');
    const fresh = signalQueue.filter(s => s.id > since);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ signals: fresh, total: signalQueue.length, scanMode }));
    return;
  }

  // Clear signal queue
  if(url.pathname === '/signals/clear') {
    signalQueue = [];
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status: 'cleared' }));
    return;
  }

  // Coinbase order execution
  if(url.pathname === '/coinbase/order' && req.method === 'POST'){
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { ticker, side, amount, price, apiKey, apiSecret } = JSON.parse(body);
        if(!ticker||!side||!amount||!apiKey||!apiSecret){
          res.writeHead(400,{'Content-Type':'application/json'});
          res.end(JSON.stringify({success:false,error:'Missing fields'}));
          return;
        }
        console.log(`Order: ${side} ${ticker} $${amount} @ $${price}`);
        const result = await placeCoinbaseAdvancedOrder(apiKey, apiSecret, ticker, side, parseFloat(amount), parseFloat(price||1));
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch(e){
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({success:false,error:e.message}));
      }
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'application/json'});
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── COINBASE ORDER EXECUTION (Legacy HMAC Auth) ─────────────
function signCoinbaseRequest(timestamp, method, path, body, apiSecret){
  const message = timestamp + method.toUpperCase() + path + (body||'');
  return crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
}

async function placeCoinbaseAdvancedOrder(apiKey, apiSecret, ticker, side, dollarAmount, price){
  return new Promise((resolve) => {
    try {
      const timestamp = Math.floor(Date.now()/1000).toString();
      const path = '/api/v3/brokerage/orders';
      const baseSize = (dollarAmount / price).toFixed(8);
      
      // Try USDC pair first, fallback to USD
      const productId = `${ticker}-USDC`;
      const clientOrderId = `beast-${Date.now()}`;
      
      const orderData = {
        client_order_id: clientOrderId,
        product_id: productId,
        side: side,
        order_configuration: {
          market_market_ioc: {
            [side === 'BUY' ? 'quote_size' : 'base_size']: 
              side === 'BUY' ? dollarAmount.toFixed(2) : baseSize,
          }
        }
      };
      
      const orderBody = JSON.stringify(orderData);
      const signature = signCoinbaseRequest(timestamp, 'POST', path, orderBody, apiSecret);
      
      console.log(`Placing ${side} ${ticker} $${dollarAmount} via HMAC auth`);
      
      const req = https.request({
        hostname: 'api.coinbase.com',
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CB-ACCESS-KEY': apiKey,
          'CB-ACCESS-SIGN': signature,
          'CB-ACCESS-TIMESTAMP': timestamp,
          'Content-Length': Buffer.byteLength(orderBody),
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            console.log('Coinbase response:', JSON.stringify(parsed).slice(0,300));
            if(parsed.success){
              resolve({
                success: true,
                orderId: parsed.success_response?.order_id||clientOrderId,
                ticker, side, dollarAmount,
                productId,
              });
            } else {
              // Try USD pair if USDC failed
              const errMsg = parsed.error_response?.message||parsed.error||JSON.stringify(parsed);
              console.log('Order error:', errMsg);
              resolve({success:false, error:errMsg});
            }
          } catch(e){ resolve({success:false, error:'Parse error: '+data.slice(0,100)}); }
        });
      });
      req.on('error', e => resolve({success:false, error:e.message}));
      req.write(orderBody);
      req.end();
    } catch(e){ resolve({success:false, error:e.message}); }
  });
}


server.listen(PORT, () => {
  console.log(`Beast server v4 on port ${PORT}`);
  console.log(`Stocks + Crypto prices + Server-side scanning ready`);
  if(ANTHROPIC_KEY) {
    console.log('Anthropic key loaded — server scanning enabled');
  } else {
    console.log('No ANTHROPIC_KEY — server scanning disabled (prices still work)');
  }
});
