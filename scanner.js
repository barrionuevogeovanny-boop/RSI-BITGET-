// scanner.js — GitHub Actions · escanea Binance cada 5 min
const https = require('https');
const fs    = require('fs');

const TIMEFRAMES  = ['15m', '1h', '4h'];
const VOL_MIN_USD = 2_000_000;
const RSI_SELL    = 80;
const RSI_BUY     = 25;
const EXCLUDE     = ['UPUSDT','DOWNUSDT','BULLUSDT','BEARUSDT','3LUSDT','3SUSDT','2LUSDT','2SUSDT'];

// HTTP con reintentos
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'NexusRSI/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('parse')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await get(url); }
    catch(e) {
      if (i < retries - 1) await sleep(500 * (i + 1));
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Concurrencia controlada — procesa N en paralelo
async function mapConcurrent(arr, fn, concurrency = 15) {
  const results = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    const batch = arr.slice(i, i + concurrency);
    const res   = await Promise.allSettled(batch.map(fn));
    results.push(...res);
    await sleep(80);
  }
  return results;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 2) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(period-1) + (d>0?d:0)) / period;
    al = (al*(period-1) + (d<0?-d:0)) / period;
  }
  return al === 0 ? 100 : 100 - 100/(1 + ag/al);
}

function label(rsi) {
  if (rsi >= 90) return 'EXTREMO';
  if (rsi >= 85) return 'MUY ALTO';
  if (rsi >= 80) return 'ALTO';
  if (rsi <= 10) return 'EXTREMO';
  if (rsi <= 15) return 'MUY BAJO';
  if (rsi <= 20) return 'BAJO';
  if (rsi <= 25) return 'SOBREVENDIDO';
  return '';
}

async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando escaneo...`);

  // 1. Obtener tickers
  let tickers = await getWithRetry('https://data-api.binance.vision/api/v3/ticker/24hr');
  if (!Array.isArray(tickers)) {
    tickers = await getWithRetry('https://api.binance.com/api/v3/ticker/24hr');
  }
  if (!Array.isArray(tickers)) throw new Error('No se pudo obtener tickers');

  const symbols = tickers
    .filter(t => {
      const vol = parseFloat(t.quoteVolume) || 0;
      return t.symbol.endsWith('USDT') &&
             vol >= VOL_MIN_USD &&
             t.symbol.length <= 15 &&
             !EXCLUDE.includes(t.symbol);
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .map(t => ({ sym: t.symbol, price: parseFloat(t.lastPrice), vol: parseFloat(t.quoteVolume) }));

  console.log(`  ${symbols.length} pares con vol >$${(VOL_MIN_USD/1e6).toFixed(0)}M`);

  const results = {};

  for (const tf of TIMEFRAMES) {
    console.log(`  Escaneando ${tf}...`);
    results[tf] = { sell: [], buy: [], scanned: 0 };

    await mapConcurrent(symbols, async ({ sym, price, vol }) => {
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${tf}&limit=70`;
      const klines = await getWithRetry(url, 2);
      if (!klines || !Array.isArray(klines) || klines.length < 16) return;

      const closes = klines.map(k => parseFloat(k[4]));
      const rsi    = calcRSI(closes);
      if (rsi === null) return;

      const rv = Math.round(rsi * 10) / 10;
      results[tf].scanned++;

      if (rsi >= RSI_SELL) {
        results[tf].sell.push({ sym, rsi: rv, price, vol, label: label(rsi) });
        results[tf].sell.sort((a, b) => b.rsi - a.rsi);
        console.log(`    SELL ${sym} RSI:${rv}`);
      } else if (rsi <= RSI_BUY) {
        results[tf].buy.push({ sym, rsi: rv, price, vol, label: label(rsi) });
        results[tf].buy.sort((a, b) => a.rsi - b.rsi);
        console.log(`    BUY  ${sym} RSI:${rv}`);
      }
    }, 15); // 15 peticiones en paralelo

    console.log(`  [${tf}] ${results[tf].scanned} escaneados · ${results[tf].sell.length}V ${results[tf].buy.length}C`);
  }

  const output = {
    updated:    new Date().toISOString(),
    updated_ts: Date.now(),
    config: { rsi_sell: RSI_SELL, rsi_buy: RSI_BUY, vol_min: VOL_MIN_USD, timeframes: TIMEFRAMES },
    signals: results
  };

  fs.writeFileSync('signals.json', JSON.stringify(output, null, 2));
  const total = TIMEFRAMES.reduce((a, tf) => a + results[tf].sell.length + results[tf].buy.length, 0);
  console.log(`[${new Date().toISOString()}] Done · ${total} señales totales ✓`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
