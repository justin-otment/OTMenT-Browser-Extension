// ==============================================
// Webpack Config for OTMenT Browser Extension
// ==============================================
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  mode: "production",
  entry: {
    navigator: "./navigator.js",       // background service worker
    content: "./content.js",           // content script
    options: "./options.js",           // options page logic
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].bundle.js",      // generates navigator.bundle.js, etc.
    clean: true,
  },
  resolve: {
    extensions: [".js", ".json"],
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [["@babel/preset-env", { targets: "defaults" }]],
          },
        },
      },
    ],
  },
  optimization: {
    minimize: false, // keep readable for debugging if needed
  },
};
