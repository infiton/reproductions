import Fastify from "fastify";
import { createServer, type ViteDevServer } from "vite";
import fastifyReactRouter from "./lib/fastify-react-router";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServerBuild } from "react-router";
import getPort from "get-port";

declare module "fastify" {
  interface FastifyRequest {
    viteServer: ViteDevServer;
    serverBuild: ServerBuild;
  }
}

const fastify = Fastify({
  logger: true,
});

let vite: { server: ViteDevServer } = { server: null as unknown as ViteDevServer };
let serverBuildCache: Map<ViteDevServer, ServerBuild> = new Map();
let serverIdCounter = 0;
let serverIdMap: Map<ViteDevServer, number> = new Map();

async function getServerBuild(viteServer: ViteDevServer): Promise<ServerBuild> {
  const cached = serverBuildCache.get(viteServer);
  if (cached) {
    return cached;
  }

  const build = await viteServer.ssrLoadModule("virtual:react-router/server-build") as ServerBuild;
  serverBuildCache.set(viteServer, build);
  return build;
}

let restarting: Promise<void> | null = null;

const restartVite = async () => {
  const [port, hmrPort] = await Promise.all([
    getPort(),
    getPort(),
  ]);

  // Create new server but DON'T close the old one yet
  // Let in-flight requests finish with the old server
  const newServer = await createServer({
    server: {
      port,
      middlewareMode: true,
      hmr: {
        port: hmrPort,
      },
    },
  });

  serverIdCounter++;
  serverIdMap.set(newServer, serverIdCounter);
  console.log(`[vite] Created new server #${serverIdCounter}`);

  vite.server = newServer;
  await getServerBuild(newServer);
};

let waterfallCounter = 0;
const waterfallRestartOn = 20;

fastify.addHook("onRequest", async (request, reply) => {
  // Capture the vite server for this request BEFORE any restart logic
  // This ensures in-flight requests continue using their original server
  const capturedViteServer = vite.server;
  
  // Capture whether a restart was already in progress when this request started
  const restartWasAlreadyInProgress = restarting !== null;

  // pretend we have a cold start for the vite server on first request
  if (request.url === "/") {
    const viteCache = path.join(process.cwd(), "node_modules/.vite");
    if (
      await fs
        .stat(viteCache)
        .then(() => true)
        .catch(() => false)
    ) {
      await fs.rmdir(viteCache, { recursive: true });
    }

    await restartVite();
    waterfallCounter = 0;
    restarting = null; // Reset so next waterfall can trigger fresh restart

    // Use the NEW server for the initial page request
    request.viteServer = vite.server;
    request.serverBuild = await getServerBuild(vite.server);
    return;
  }

  waterfallCounter++;
  
  // Capture this request's position in the waterfall BEFORE any async work
  const myWaterfallPosition = waterfallCounter;

  if (myWaterfallPosition == waterfallRestartOn) {
    // This request triggers the restart
    console.log(`[request #${myWaterfallPosition}] TRIGGERING RESTART - requests 1-${waterfallRestartOn - 1} should use old server, ${waterfallRestartOn}+ should use new`);
    restarting = restartVite();
  }

  // Decide which server this request should use based on:
  // 1. If this request triggered the restart (position == restartOn) -> use new server
  // 2. If restart was already in progress when we entered -> use new server  
  // 3. Otherwise -> use old server (even if restart starts later due to another request)
  const shouldUseNewServer = myWaterfallPosition >= waterfallRestartOn || restartWasAlreadyInProgress;

  if (shouldUseNewServer && restarting) {
    await restarting;
    request.viteServer = vite.server;
    request.serverBuild = await getServerBuild(vite.server);
    console.log(`[request #${myWaterfallPosition}] ${request.url} -> using NEW server #${serverIdMap.get(vite.server)}`);
  } else {
    // Use the server that was active when this request started
    request.viteServer = capturedViteServer;
    request.serverBuild = await getServerBuild(capturedViteServer);
    console.log(`[request #${myWaterfallPosition}] ${request.url} -> using OLD server #${serverIdMap.get(capturedViteServer)}`);
  }
});

fastify.register(fastifyReactRouter);

await restartVite();

fastify.listen({ port: 3000 }, function (err) {

  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
