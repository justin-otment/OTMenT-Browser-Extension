import fs from "fs/promises";
import path from "path";

export async function loadNodeConfig() {
  const baseDir = path.resolve("./GitHub-Onyot"); // <-- your extension subfolder

  const config = JSON.parse(await fs.readFile(path.join(baseDir, "config.json"), "utf8"));
  const sa     = JSON.parse(await fs.readFile(path.join(baseDir, "service-account.json"), "utf8"));

  return {
    config,
    serviceAccount: {
      client_email: sa.client_email,
      token_uri: sa.token_uri
    },
    rsaPrivateKey: sa.private_key
  };
}
