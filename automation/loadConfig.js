import fs from "fs/promises";

export async function loadNodeConfig() {
  const config = JSON.parse(await fs.readFile("./config.json", "utf8"));
  const sa     = JSON.parse(await fs.readFile("./service-account.json", "utf8"));

  return {
    config,
    serviceAccount: {
      client_email: sa.client_email,
      token_uri: sa.token_uri
    },
    rsaPrivateKey: sa.private_key
  };
}
