  'LTC-USD-SPOT': Object.freeze({
    label: 'LTC / USD', base: 'LTC', quote: 'USD', product: 'spot',
    intervals: ['1m', '5m', '15m', '1h', '1d'],
    venues: [
      {market: 'kraken', symbol: 'LTCUSD'},
      {market: 'coinbase', symbol: 'LTCUSD'}
    ]
  }),
  'LTC-USDT-SPOT': Object.freeze({
    label: 'LTC / USDT', base: 'LTC', quote: 'USDT', product: 'spot',
    intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'],
    venues: [{market: 'spot', symbol: 'LTCUSDT'}]
  }),
  'LTC-USDT-PERP': Object.freeze({
    label: 'LTC / USDT · perpetual', base: 'LTC', quote: 'USDT', product: 'perpetual',
    intervals: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'],
    venues: [{market: 'futures', symbol: 'LTCUSDT'}]
  }),
$FROM
