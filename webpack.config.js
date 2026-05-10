const path = require('path');

// Enable source maps in dev mode so F5 debugging shows TypeScript, not
// compiled JS.  Set NODE_ENV=production for production packaging.
const production = process.env.NODE_ENV === 'production';

module.exports = {
  target: 'node',
  mode:   production ? 'production' : 'none',

  entry:  './src/extension.ts',
  output: {
    path:           path.resolve(__dirname, 'dist'),
    filename:       'extension.js',
    libraryTarget:  'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },

  devtool: production ? false : 'source-map',

  externals: {
    vscode: 'commonjs vscode',
  },

  resolve: { extensions: ['.ts', '.js'] },

  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};
