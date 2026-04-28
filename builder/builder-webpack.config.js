const path = require('path');
const nodeExternals = require('webpack-node-externals');

const sharedConfig = {
  mode: 'production',
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
    path: path.resolve(process.cwd(), 'dist'),
  },
};

module.exports = [
  {
    ...sharedConfig,
    entry: path.resolve(__dirname, 'electron-builder.ts'),
    target: 'electron-main',
    output: {
      ...sharedConfig.output,
      filename: 'main.js',
      libraryTarget: 'umd',
      libraryExport: 'default',
    },
    externals: [
      nodeExternals(),
      '../dist/server',
    ],
  },
  {
    ...sharedConfig,
    entry: path.resolve(__dirname, 'preload.ts'),
    target: 'electron-main',
    output: {
      ...sharedConfig.output,
      filename: 'preload.js',
    },
    externals: [
      nodeExternals(),
    ],
  },
];
