const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  // ---------------- Entry points ----------------
  entry: {
    content: "./content.js",
    navigator: "./navigator.js",
    options: "./options.js",
    cryptoUtils: "./crypto-utils.js",
    cryptoWorker: "./crypto-worker.js",
  },

  // ---------------- Output ----------------
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js", // keep filenames same as entry
  },

  // ---------------- Module rules ----------------
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: "babel-loader",
      },
    ],
  },

  // ---------------- Plugins ----------------
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json", to: "" },
        { from: "options.html", to: "" },
        { from: "jquery-3.7.1.min.js", to: "" },
        { from: "config.json", to: "" },
        { from: "config-schema.json", to: "" },
      ],
    }),
  ],

  // ---------------- Mode ----------------
  mode: "production",
};