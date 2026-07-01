import type { FastifyInstance } from "fastify";
import { sendError } from "../../errors";
import { checkHealth, checkReady, type HealthDeps } from "./service";

export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/health", async () => checkHealth());

  app.get("/ready", async (_req, reply) => {
    const ready = await checkReady(deps);
    if (ready.status === "ready") return ready;
    return sendError(
      reply,
      503,
      "not_ready",
      { ...ready },
      "One or more dependencies are not ready",
    );
  });
}
