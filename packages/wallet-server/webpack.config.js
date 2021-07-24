const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  entry: './src/index.ts',
  mode: 'production',
  target: 'node',
  module: {
    rules: [
      {
        test: /\.ts?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'server.min.js',
    path: path.resolve(__dirname, '../../dist/server'),
    libraryTarget: 'umd',
    libraryExport: 'default'
  },
  externals: [
    'long',
    'pino-pretty',
  ],
  optimization: {
    minimizer: [
      new TerserPlugin({ extractComments: false}),
    ],
  },
};