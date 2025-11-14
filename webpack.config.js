const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  entry: {
    // background/service worker
    navigator: "./navigator.js",

    // content scripts
    content: "./content.js",

    // options page JS
    options: "./options.js",

    // crypto modules
    cryptoUtils: "./crypto-utils.js",

    // crypto worker emitted as its own file
    cryptoWorker: {
      import: "./crypto-worker.js",
      filename: "crypto-worker.js",
    },
  },

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    clean: true, // cleans dist/ before building
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
        // Copy all necessary root files to dist/
        { from: "manifest.json", to: "" },
        { from: "navigator.js", to: "" },
        { from: "content.js", to: "" },
        { from: "options.html", to: "" },
        { from: "jquery-3.7.1.min.js", to: "" },
        { from: "config.json", to: "" },
        { from: "service-account.json", to: "" },
        { from: "config-schema.json", to: "" }
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