const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    // navigator.js = your background/service worker
    navigator: "./navigator.js",

    // content scripts
    content: "./content.js",

    // options page JS
    options: "./options.js",

    // crypto modules
    cryptoUtils: "./crypto-utils.js",

    // worker must be emitted as its own file, not chunked
    cryptoWorker: {
      import: "./crypto-worker.js",
      filename: "crypto-worker.js",
    },
  },

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true,
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
        { from: "manifest.json", to: "" },
        { from: "options.html", to: "" },
        { from: "jquery-3.7.1.min.js", to: "" },
        { from: "config.json", to: "" },
        { from: "config-schema.json", to: "" },
        { from: "service-account.json", to: "" },
      ],
    }),
  ],

  // Allow workers + async imports
  experiments: {
    asyncWebAssembly: true,
    topLevelAwait: true,
  },

  mode: "production",
  devtool: false,
};
