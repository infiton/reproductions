import { createReadableStreamFromReadable } from "@react-router/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { createRequestHandler } from "react-router";
import type { ViteDevServer } from "vite";
import type { ServerBuild } from "react-router";

declare module "fastify" {
  interface FastifyRequest {
    viteServer: ViteDevServer;
    serverBuild: ServerBuild;
  }
}

const plugin = async (
  fastify: FastifyInstance,
) => {
  // Use the vite server that was captured for this specific request
  // This ensures in-flight requests continue using their original server
  // even after a restart creates a new server
  fastify.addHook("onRequest", (request, reply, done) => {
    request.viteServer.middlewares(request.raw, reply.raw, done);
  });

  fastify.all("/*", async (request, reply) => {
    // Use the server build that was captured for this specific request
    const reactRouterRequestHandler = createRequestHandler(
      request.serverBuild,
      "development"
    );

    const req = createReactRouterRequestFromFastify(request, reply);
    const response = await reactRouterRequestHandler(req);

    reply.status(response.status);

    for (const [key, values] of response.headers.entries()) {
      reply.headers({ [key]: values });
    }

    if (response.body) {
      const reader = response.body.getReader();
      const readable = new Readable();

      readable._read = async () => {
        const result = await reader.read();
        if (!result.done) {
          readable.push(Buffer.from(result.value));
        } else {
          readable.push(null);
          return;
        }
      };

      return await reply.send(readable);
    }

    return await reply.send(await response.text());
  });
};

const createReactRouterRequestFromFastify = (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const origin = `${request.protocol}://${request.hostname}`;
  const url = `${origin}${request.originalUrl}`;

  let controller: AbortController | null = new AbortController();

  const headers = new Headers();

  for (const [key, values] of Object.entries(request.headers)) {
    if (values) {
      if (Array.isArray(values)) {
        for (const value of values) {
          headers.append(key, value);
        }
      } else {
        headers.set(key, values);
      }
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    signal: controller.signal,
  };

  reply.raw.on("finish", () => (controller = null));
  reply.raw.on("close", () => controller?.abort());

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = createReadableStreamFromReadable(request.raw);
    (init as any).duplex = "half";
  }

  return new Request(url, init);
};

export default plugin;
