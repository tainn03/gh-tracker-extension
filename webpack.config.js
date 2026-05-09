const path = require('path');

module.exports = {
  target: 'node',
  mode:   'none',

  entry:  './src/extension.ts',
  output: {
    path:           path.resolve(__dirname, 'dist'),
    filename:       'extension.js',
    libraryTarget:  'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },

  externals: {
    vscode:           'commonjs vscode',
    'better-sqlite3': 'commonjs better-sqlite3',
  },

  resolve: { extensions: ['.ts', '.js'] },

  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};
