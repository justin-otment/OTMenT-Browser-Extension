import path from "path";
import CopyPlugin from "copy-webpack-plugin";

export default {
  entry: {
    content: "./content.js",
    navigator: "./navigator.js",
    options: "./options.js",
    cryptoUtils: "./crypto-utils.js",
    cryptoWorker: "./crypto-worker.js",
  },
  output: {
    path: path.resolve("./dist"),
    filename: "[name].js",
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: "babel-loader",
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
  mode: "production",
};