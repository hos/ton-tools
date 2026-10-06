import { createServer, type Server, type ServerResponse } from "node:http";

import type { ServerStats } from "../source/liteserver/server-pool";
import type { TonWatch } from "../ton-watch";
import type { Logger } from "../util/logger";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4";

/** JSON with bigints written as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_, field) => (typeof field === "bigint" ? field.toString() : field),
    2,
  );
}

/**
 * Serves `/metrics` (Prometheus), `/health` (503 when down) and `/status`
 * (per-address progress and liteserver stats).
 */
export function startHttpServer(
  watch: TonWatch,
  serverStats: () => ServerStats[],
  port: number,
  logger: Logger,
): Server {
  const sendJson = (response: ServerResponse, value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(toJson(value));
  };
  return createServer((request, response) => {
    switch (request.url) {
      case "/metrics":
        response.setHeader("content-type", PROMETHEUS_CONTENT_TYPE);
        response.end(watch.metrics.toPrometheus());
        return;
      case "/health": {
        const health = watch.health();
        response.statusCode = health.status === "down" ? 503 : 200;
        sendJson(response, health);
        return;
      }
      case "/status":
        sendJson(response, { addresses: watch.status(), servers: serverStats() });
        return;
      default:
        response.statusCode = 404;
        response.end();
    }
  }).listen(port, () => logger.info(`health on :${port}/health, metrics on :${port}/metrics`));
}
