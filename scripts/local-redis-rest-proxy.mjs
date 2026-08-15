import { createServer } from "node:http";

import { createClient } from "redis";

const redisUrl = process.env.LOCAL_REDIS_URL ?? "redis://127.0.0.1:6389";
const port = Number(process.env.LOCAL_REDIS_REST_PORT ?? "8079");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("LOCAL_REDIS_REST_PORT must be a valid TCP port.");
}

const redis = createClient({ url: redisUrl });
await redis.connect();

function encoded(value) {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  if (Array.isArray(value)) return value.map(encoded);
  return value;
}

async function commandResult(command) {
  if (!Array.isArray(command) || command.length === 0 || command.length > 1_024) {
    return { error: "invalid_local_redis_command", result: null };
  }
  try {
    const result = await redis.sendCommand(command.map((part) => String(part)));
    return { result: encoded(result) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "local_redis_command_failed",
      result: null,
    };
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > 2 * 1_024 * 1_024) {
      response.writeHead(413).end();
      return;
    }
  }
  try {
    const body = JSON.parse(raw);
    const pipeline = request.url === "/pipeline" || request.url === "/multi-exec";
    let result;
    if (pipeline) {
      if (!Array.isArray(body)) throw new Error("invalid_local_redis_pipeline");
      result = [];
      for (const command of body) result.push(await commandResult(command));
    } else {
      result = await commandResult(body);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_local_redis_request" }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.info(`Local Redis REST proxy listening on http://127.0.0.1:${port}`);
});

async function shutdown() {
  server.close();
  await redis.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
