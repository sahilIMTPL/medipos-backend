import { buildServer } from "./server";
import { config } from "./config";

async function main() {
  try {
    const server = await buildServer();
    await server.listen({
      port: config.port,
      host: config.host,
    });
    console.log(`🚀 Medical POS Fastify Server running at http://${config.host}:${config.port}`);
    console.log(`🩺 Health check available at http://${config.host}:${config.port}/api/health`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
