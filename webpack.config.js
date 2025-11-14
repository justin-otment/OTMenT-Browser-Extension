const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    // content scripts
    content: "./content.js",

    // options page
    options: "./options.js",

    // crypto modules
    cryptoUtils: "./crypto-utils.js",

    // worker (must remain separate)
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
        exclude: /node_modules|navigator\.js/, // <-- DO NOT TRANSPILE SERVICE WORKER
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

        // ★ CRITICAL FIX: Copy service worker *as-is*
        { from: "navigator.js", to: "" },
      ],
    }),
  ],

  experiments: {
    asyncWebAssembly: true,
    topLevelAwait: true,
  },

  mode: "production",
  devtool: false,
};