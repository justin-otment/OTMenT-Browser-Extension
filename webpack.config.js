const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    // Do NOT bundle navigator.js (MV3 service worker) — copy as-is
    content: "./content.js",
    options: "./options.js",
    cryptoUtils: "./crypto-utils.js",
    cryptoWorker: {
      import: "./crypto-worker.js",
      filename: "crypto-worker.js",
    },
  },

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true, // clean dist/ before building
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [["@babel/preset-env", { targets: { chrome: "120" } }]],
          },
        },
      },
    ],
  },

  plugins: [
    new CopyPlugin({
      patterns: [
        // Copy navigator.js as-is (MV3 service worker)
        { from: "navigator.js", to: "" },
        // Copy other necessary root files
        { from: "manifest.json", to: "" },
        { from: "content.js", to: "" },
        { from: "options.html", to: "" },
        { from: "jquery-3.7.1.min.js", to: "" },
        { from: "config.json", to: "" },
        { from: "service-account.json", to: "" },
        { from: "config-schema.json", to: "" },
      ],
    }),
  ],

  // Enable workers + async imports if needed
  experiments: {
    asyncWebAssembly: true,
    topLevelAwait: true,
  },

  mode: "production",
  devtool: false,
};