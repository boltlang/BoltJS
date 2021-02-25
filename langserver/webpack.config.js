
const path = require('path');
const webpack = require('webpack');

module.exports = {
  target: 'node',
  entry: {
    'bolt-langserver': './src/main.ts'
  },
  output: {
    filename: 'bin/[name].js',
    path: path.resolve(__dirname),
    devtoolModuleFilenameTemplate: '[absolute-resource-path]'
  },
  externals: {
    '@bolt/compiler': path.resolve(__dirname, '..', 'compiler'),
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  plugins: [
    new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true }),
  ],
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.(m?js|ts)$/,
        exclude: /node_modules/,
        loader: 'babel-loader'
      },
    ]
  }
};
