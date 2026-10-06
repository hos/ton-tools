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

/** Methods the server answers; any other gets 405. HEAD is GET without the body. */
const ALLOWED_METHODS = "GET, HEAD";

/**
 * Serves `/metrics` (Prometheus), `/health` (503 when down), `/status` and
 * `/consumers` (500 if the database query fails) to GET and HEAD; other methods
 * get 405, unknown paths 404. The query string is ignored.
 *
 * Resolves once the server listens; rejects (and closes it) if it cannot, e.g.
 * when the port is in use. Errors after that are logged.
 */
export function startHttpServer(
  probe: ServiceProbe,
  port: number,
  logger: Logger,
): Promise<Server> {
  const sendJson = (response: ServerResponse, value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(toJson(value));
  };
  const server = createServer((request, response) => {
    const path = pathname(request.url);
    if (!ROUTES.has(path)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", ALLOWED_METHODS);
      response.end();
      return;
    }
    switch (path) {
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
    }
  });
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.close();
      reject(new Error(`cannot serve HTTP on port ${port}: ${error.message}`));
    };
    server.once("error", failed);
    server.listen(port, () => {
      server.off("error", failed);
      server.on("error", (error) => logger.error("HTTP server error:", error.message));
      logger.info(`health on :${port}/health, metrics on :${port}/metrics`);
      resolve(server);
    });
  });
}

const ROUTES: ReadonlySet<string> = new Set(["/metrics", "/health", "/status", "/consumers"]);

/** The path of a request target, without the query string. */
function pathname(url: string | undefined): string {
  return (url ?? "/").split(/[?#]/, 1)[0] ?? "/";
}
