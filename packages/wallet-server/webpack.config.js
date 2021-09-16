const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const CopyPlugin = require("copy-webpack-plugin");

const osPATH = {
  WINDOWS: path.resolve(__dirname, 'src', 'litecoind.exe'),
  LINUX: path.resolve(__dirname, 'src', 'litecoind'),
  MAC: path.resolve(__dirname, 'src', 'litecoind-mac'),
};

module.exports = (env) => {
  const { os } = env;
  const osList = ["WINDOWS", "LINUX", "MAC"];
  if (!os || !osPATH[os] ) return;
  const fromPath = osPATH[os];
  return {
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: fromPath,
          }
        ]
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
      'utf-8-validate'
    ],
    optimization: {
      minimizer: [
        new TerserPlugin({ extractComments: false}),
      ],
    },
  };
}