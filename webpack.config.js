const path = require("path");

module.exports = {
  // Multiple entry points for your scripts
  entry: {
    content: "./content.js",
    navigator: "./navigator.js",
    options: "./options.js",
    cryptoUtils: "./crypto-utils.js",
    cryptoWorker: "./crypto-worker.js",
  },

  // Output to dist/ folder with same names
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
  },

  // Babel loader for JS transpiling
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: "babel-loader",
      },
    ],
  },

  // Production mode for minification and optimization
  mode: "production",
}; 