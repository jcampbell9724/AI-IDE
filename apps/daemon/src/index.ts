import { readConfig } from "./config.js";
import { loadRootEnv } from "./env.js";
import { createDaemonRuntime } from "./runtime.js";

loadRootEnv();
const config = readConfig();
const runtime = createDaemonRuntime({ config });

runtime.server.listen(config.port, config.host, () => {
  console.log(`Browser agent daemon listening on http://${config.host}:${config.port}`);
  if (config.generatedBearerToken) {
    console.log(`Pairing bearer token: ${config.bearerToken}`);
  }
});

const shutdown = async (): Promise<void> => {
  const forcedExit = setTimeout(() => process.exit(1), 5000);
  forcedExit.unref();
  await runtime.shutdown();
  clearTimeout(forcedExit);
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
