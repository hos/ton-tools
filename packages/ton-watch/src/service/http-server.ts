import { createServer, type Server, type ServerResponse } from "node:http";

import { errorMessage } from "../core/errors";
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

/** What the HTTP server reports; one per service mode. */
export interface ServiceProbe {
  /** Prometheus text. */
  metrics(): string;
  /** Served on `/health`; `down` answers 503. */
  health(): { status: "ok" | "degraded" | "down" };
  /** Served on `/status`. */
  status(): unknown;
  /** Served on `/consumers`: every consumer in the database, read-only. */
  consumers(): Promise<unknown>;
}

/**
 * Serves `/metrics` (Prometheus), `/health` (503 when down), `/status` and
 * `/consumers` (500 if the database query fails).
 */
export function startHttpServer(probe: ServiceProbe, port: number, logger: Logger): Server {
  const sendJson = (response: ServerResponse, value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(toJson(value));
  };
  return createServer((request, response) => {
    switch (request.url) {
      case "/metrics":
        response.setHeader("content-type", PROMETHEUS_CONTENT_TYPE);
        response.end(probe.metrics());
        return;
      case "/health": {
        const health = probe.health();
        response.statusCode = health.status === "down" ? 503 : 200;
        sendJson(response, health);
        return;
      }
      case "/status":
        sendJson(response, probe.status());
        return;
      case "/consumers":
        probe.consumers().then(
          (consumers) => sendJson(response, consumers),
          (error: unknown) => {
            logger.warn("/consumers failed:", errorMessage(error));
            response.statusCode = 500;
            sendJson(response, { error: errorMessage(error) });
          },
        );
        return;
      default:
        response.statusCode = 404;
        response.end();
    }
  }).listen(port, () => logger.info(`health on :${port}/health, metrics on :${port}/metrics`));
}
