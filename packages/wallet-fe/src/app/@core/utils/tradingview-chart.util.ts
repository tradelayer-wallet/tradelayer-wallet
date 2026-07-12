const TRADING_VIEW_SCRIPT_URL = 'https://s3.tradingview.com/tv.js';

let tradingViewScriptPromise: Promise<void> | null = null;

export function resolveTradingViewSymbol(rawSymbol?: string | null): string | null {
  if (!rawSymbol) return null;

  const cleaned = rawSymbol
    .toUpperCase()
    .replace(/_PERP|PERP|-PERP/g, '')
    .replace(/\s+/g, '')
    .replace(/:/g, '');

  const direct: Record<string, string> = {
    BTCUSD: 'COINBASE:BTCUSD',
    XBTUSD: 'COINBASE:BTCUSD',
    BTCUSDT: 'BINANCE:BTCUSDT',
    ETHUSD: 'COINBASE:ETHUSD',
    ETHUSDT: 'BINANCE:ETHUSDT',
    LTCUSD: 'COINBASE:LTCUSD',
    LTCBTC: 'BINANCE:LTCBTC',
    DOGEUSD: 'COINBASE:DOGEUSD',
    DOGEUSDT: 'BINANCE:DOGEUSDT',
    SOLUSD: 'COINBASE:SOLUSD',
    SOLUSDT: 'BINANCE:SOLUSDT',
    XRPUSD: 'COINBASE:XRPUSD',
    XRPUSDT: 'BINANCE:XRPUSDT',
    ADAUSD: 'COINBASE:ADAUSD',
    ADAUSDT: 'BINANCE:ADAUSDT',
    AVAXUSD: 'COINBASE:AVAXUSD',
    AVAXUSDT: 'BINANCE:AVAXUSDT',
    BCHUSD: 'COINBASE:BCHUSD',
    BCHUSDT: 'BINANCE:BCHUSDT',
  };

  const compact = cleaned.replace(/[/-]/g, '');
  if (direct[compact]) return direct[compact];

  const parsed = parsePair(cleaned);
  if (!parsed) return null;

  const base = normalizeAsset(parsed.base);
  const quote = normalizeAsset(parsed.quote);
  if (!base || !quote) return null;

  if (quote === 'USD') return `COINBASE:${base}USD`;
  if (quote === 'USDT') return `BINANCE:${base}USDT`;
  if (quote === 'BTC') return `BINANCE:${base}BTC`;
  return null;
}

export function tradingViewInterval(seconds: number): string {
  if (seconds >= 86400) return 'D';
  if (seconds >= 21600) return '360';
  if (seconds >= 7200) return '120';
  if (seconds >= 3600) return '60';
  if (seconds >= 1800) return '30';
  if (seconds >= 900) return '15';
  if (seconds >= 300) return '5';
  return '1';
}

export function loadTradingViewScript(): Promise<void> {
  if ((window as any).TradingView?.widget) return Promise.resolve();
  if (tradingViewScriptPromise) return tradingViewScriptPromise;

  tradingViewScriptPromise = new Promise((resolve, reject) => {
    let timeoutId: number;
    const fail = (err: Error) => {
      window.clearTimeout(timeoutId);
      tradingViewScriptPromise = null;
      reject(err);
    };
    const finish = () => {
      window.clearTimeout(timeoutId);
      if ((window as any).TradingView?.widget) resolve();
      else fail(new Error('TradingView widget constructor unavailable'));
    };

    timeoutId = window.setTimeout(
      () => fail(new Error('TradingView script timed out')),
      8000
    );

    const existing = document.querySelector(`script[src="${TRADING_VIEW_SCRIPT_URL}"]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => fail(new Error('TradingView script failed to load')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = TRADING_VIEW_SCRIPT_URL;
    script.async = true;
    script.onload = finish;
    script.onerror = () => fail(new Error('TradingView script failed to load'));
    document.head.appendChild(script);
  });

  return tradingViewScriptPromise;
}

export function createTradingViewWidget(container: HTMLElement, symbol: string, interval: string): any {
  const widgetCtor = (window as any).TradingView?.widget;
  if (!widgetCtor) throw new Error('TradingView widget constructor unavailable');

  const containerId = `tradingview_${Math.random().toString(36).slice(2)}`;
  container.innerHTML = '';

  const mount = document.createElement('div');
  mount.id = containerId;
  mount.style.width = '100%';
  mount.style.height = '100%';
  container.appendChild(mount);

  return new widgetCtor({
    autosize: true,
    symbol,
    interval,
    timezone: 'Etc/UTC',
    theme: 'dark',
    style: '1',
    locale: 'en',
    toolbar_bg: '#1B1E34',
    enable_publishing: false,
    allow_symbol_change: true,
    hide_side_toolbar: false,
    calendar: false,
    save_image: false,
    support_host: 'https://www.tradingview.com',
    container_id: containerId,
  });
}

function parsePair(symbol: string): { base: string; quote: string } | null {
  const parts = symbol.split(/[/-]/).filter(Boolean);
  if (parts.length >= 2) return { base: parts[0], quote: parts[1] };

  for (const quote of ['USDT', 'USD', 'BTC']) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return { base: symbol.slice(0, -quote.length), quote };
    }
  }
  return null;
}

function normalizeAsset(asset: string): string {
  let value = asset.toUpperCase();
  if (value.startsWith('TL') && value.length > 2) value = value.slice(2);
  if (value.startsWith('T') && ['TBTC', 'TLTC', 'TETH', 'TDOGE'].includes(value)) value = value.slice(1);
  if (value === 'XBT') return 'BTC';
  if (value === 'USDH' || value === 'TLUSD') return 'USD';
  return value;
}
