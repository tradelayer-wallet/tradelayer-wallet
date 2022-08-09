const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const CopyPlugin = require("copy-webpack-plugin");
const webpack = require('webpack');

const osPATH = {
  WINDOWS: [
    path.resolve(__dirname, 'src', 'core', 'litecoind.exe'),
    // path.resolve(__dirname, 'src', 'core', 'bitcoind.exe'),
  ],
  LINUX: [
    path.resolve(__dirname, 'src', 'core', 'litecoind'),
  ],
  MAC: [
    path.resolve(__dirname, 'src', 'core', 'litecoind-mac'),
  ],
};

module.exports = (env) => {
  const { os } = env;
  if (!os || !osPATH[os] ) return;
  const fromPath = osPATH[os];

  const envFilePath = os === "WINDOWS" 
    ? path.join(__dirname, 'src', 'conf', 'windows.conf.ts')
    : os === "LINUX"
      ? path.join(__dirname, 'src', 'conf', 'linux.conf.ts')
      : os === "MAC"
        ? path.join(__dirname, 'src', 'conf', 'mac.conf.ts')
        : null;
  
  if (!envFilePath) return;

  return {
    plugins: [
      new webpack.NormalModuleReplacementPlugin(
        /\windows.conf.ts?$/,
        envFilePath
      ),
      new CopyPlugin({
        patterns: [ ...fromPath ],
      })
    ],
    entry: path.join(__dirname, './src/index.ts'),
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
      // alias: {
      //   "tl-config": envFilePath,
      // }
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, '../../dist/server'),
      libraryTarget: 'umd',
      libraryExport: 'default'
    },
    externals: [
      'long',
      'pino-pretty',
      'bufferutil',
      'utf-8-validate',
      'tiny-secp256k1',
    ],
    optimization: {
      minimizer: [
        new TerserPlugin({ extractComments: false}),
      ],
    },
  };
}