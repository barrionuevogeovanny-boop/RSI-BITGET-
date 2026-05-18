// scanner.js — corre en GitHub Actions cada 5 minutos
// Escanea Binance, calcula RSI, guarda signals.json

const https = require('https');
const fs    = require('fs');

// ─── Configuración ───────────────────────────────────────────
const TIMEFRAMES  = ['15m', '1h', '4h'];   // escanea los 3 más usados
const RSI_PERIOD  = 14;
const VOL_MIN_USD = 4_000_000;             // $4M mínimo
const RSI_SELL    = 80;                    // señal de venta
const RSI_BUY     = 25;                    // señal de compra
const LIMIT_KLINES= 70;                    // velas por par

// Tokens basura conocidos que Binance lista pero no son reales
const EXCLUDE = ['UP','DOWN','BULL','BEAR','3L','3S','2L','2S'];

// ─── HTTP helper ─────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NexusRSI/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

// Delay para no saturar la API
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── RSI ─────────────────────────────────────────────────────
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
    ag = (ag * (period-1) + (d > 0 ? d : 0)) / period;
    al = (al * (period-1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Iniciando escaneo...`);

  // 1. Obtener todos los pares USDT con volumen > $4M
  let tickers;
  try {
    tickers = await get('https://api.binance.com/api/v3/ticker/24hr');
  } catch(e) {
    // Fallback endpoint
    tickers = await get('https://data-api.binance.vision/api/v3/ticker/24hr');
  }

  const symbols = tickers
    .filter(t => {
      const s   = t.symbol;
      const vol = parseFloat(t.quoteVolume) || 0;
      if (!s.endsWith('USDT')) return false;
      if (vol < VOL_MIN_USD) return false;
      if (s.length > 15) return false;
      if (EXCLUDE.some(ex => s.includes(ex + 'USDT'))) return false;
      return true;
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), vol: parseFloat(t.quoteVolume) }));

  console.log(`  ${symbols.length} pares activos encontrados`);

  const results = {}; // { '15m': { sell: [], buy: [] }, '1h': {...}, '4h': {...} }

  for (const tf of TIMEFRAMES) {
    results[tf] = { sell: [], buy: [], scanned: 0 };

    // Procesar en lotes de 10 con delay
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = symbols.slice(i, i + 10);

      await Promise.all(batch.map(async ({ symbol, price, vol }) => {
        try {
          const klines = await get(
            `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${LIMIT_KLINES}`
          );
          if (!klines || klines.length < 16) return;

          const closes = klines.map(k => parseFloat(k[4]));
          const rsi    = calcRSI(closes, RSI_PERIOD);
          if (rsi === null) return;

          const entry = {
            sym:   symbol,
            rsi:   Math.round(rsi * 10) / 10,
            price: price,
            vol:   vol,
            label: rsiLabel(rsi)
          };

          if (rsi >= RSI_SELL) {
            results[tf].sell.push(entry);
            results[tf].sell.sort((a, b) => b.rsi - a.rsi);
            console.log(`  [${tf}] SELL ${symbol} RSI:${entry.rsi}`);
          } else if (rsi <= RSI_BUY) {
            results[tf].buy.push(entry);
            results[tf].buy.sort((a, b) => a.rsi - b.rsi);
            console.log(`  [${tf}] BUY  ${symbol} RSI:${entry.rsi}`);
          }

          results[tf].scanned++;
        } catch(e) {
          // silencioso - continuar con siguiente par
        }
      }));

      await sleep(100); // 100ms entre lotes
    }

    console.log(`  [${tf}] Done: ${results[tf].sell.length} ventas, ${results[tf].buy.length} compras`);
  }

  // 2. Guardar signals.json
  const output = {
    updated:   new Date().toISOString(),
    updated_ts: Date.now(),
    config: {
      rsi_sell:  RSI_SELL,
      rsi_buy:   RSI_BUY,
      vol_min:   VOL_MIN_USD,
      timeframes: TIMEFRAMES
    },
    signals: results
  };

  fs.writeFileSync('signals.json', JSON.stringify(output, null, 2));
  console.log(`[${new Date().toISOString()}] signals.json guardado ✓`);
  console.log(`  Total señales: ${
    TIMEFRAMES.reduce((acc, tf) => acc + results[tf].sell.length + results[tf].buy.length, 0)
  }`);
}

function rsiLabel(rsi) {
  if (rsi >= 90) return 'EXTREMO';
  if (rsi >= 85) return 'MUY ALTO';
  if (rsi >= 80) return 'ALTO';
  if (rsi <= 10) return 'EXTREMO';
  if (rsi <= 15) return 'MUY BAJO';
  if (rsi <= 20) return 'BAJO';
  return 'SOBREVENDIDO';
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
