import Fastify from "fastify";
import { createServer, type ViteDevServer } from "vite";
import fastifyReactRouter from "./lib/fastify-react-router";
import fs from "node:fs/promises";
import path from "node:path";
import type { ServerBuild } from "react-router";
import getPort from "get-port";
import http from "node:http";
import net from "node:net";

declare module "fastify" {
  interface FastifyRequest {
    viteServer: ViteDevServer;
    serverBuild: ServerBuild;
  }
}

const HMR_PROXY_PORT = 3001;

const fastify = Fastify({
  logger: true,
});

// Active Vite server state
let activeVite: ViteDevServer | null = null;
let activeHmrPort: number | null = null;
let serverIdCounter = 0;

// Restart coordination
let restartPromise: Promise<void> | null = null;
let pendingHttpRequests: Array<() => void> = [];
let pendingWsConnections: Array<{ socket: import("node:stream").Duplex; head: Buffer; resolve: () => void }> = [];

// Server build cache
let serverBuildCache: Map<ViteDevServer, ServerBuild> = new Map();

// Track if this is the very first server start (for cold start simulation)
let isFirstStart = true;

async function getServerBuild(viteServer: ViteDevServer): Promise<ServerBuild> {
  const cached = serverBuildCache.get(viteServer);
  if (cached) {
    return cached;
  }

  const build = (await viteServer.ssrLoadModule(
    "virtual:react-router/server-build"
  )) as ServerBuild;
  serverBuildCache.set(viteServer, build);
  return build;
}

async function restartVite(): Promise<void> {
  // If already restarting, return the existing promise
  if (restartPromise) return restartPromise;

  restartPromise = (async () => {
    const oldServer = activeVite;
    const oldServerId = serverIdCounter;

    // Clear vite cache to simulate cold start (only on very first start)
    if (isFirstStart) {
      const viteCache = path.join(process.cwd(), "node_modules/.vite");
      try {
        await fs.rm(viteCache, { recursive: true, force: true });
        console.log("[vite] Cleared cache for cold start simulation");
      } catch {}
      isFirstStart = false;
    }

    const hmrPort = await getPort();

    console.log(`[vite] Starting new server with HMR port ${hmrPort}...`);

    const newServer = await createServer({
      server: {
        middlewareMode: true,
        hmr: {
          port: hmrPort,
          clientPort: HMR_PROXY_PORT, // Browser always connects to our proxy
        },
      },
    });

    serverIdCounter++;
    console.log(`[vite] Server #${serverIdCounter} started - HMR: ${hmrPort}`);

    // Swap to new server
    activeVite = newServer;
    activeHmrPort = hmrPort;

    // Pre-load the server build
    await getServerBuild(newServer);

    // Flush all pending HTTP requests
    const pendingHttp = pendingHttpRequests;
    pendingHttpRequests = [];
    for (const resolve of pendingHttp) {
      resolve();
    }

    // Flush all pending WebSocket connections
    const pendingWs = pendingWsConnections;
    pendingWsConnections = [];
    for (const pending of pendingWs) {
      pending.resolve();
    }

    // Close old server
    if (oldServer) {
      console.log(`[vite] Closing old server #${oldServerId}...`);
      serverBuildCache.delete(oldServer);
      try {
        await oldServer.close();
        console.log(`[vite] Server #${oldServerId} closed`);
      } catch (err) {
        console.error(`[vite] Error closing server #${oldServerId}:`, err);
      }
    }

    restartPromise = null;
  })();

  return restartPromise;
}

// Track restart trigger
let hasTriggeredRestart = false; // Only allow one restart
let initialServerPromise: Promise<void> | null = null;

// Lazily start the first server on first request
async function ensureFirstServer(): Promise<void> {
  if (activeVite) return;
  if (initialServerPromise) return initialServerPromise;
  
  initialServerPromise = restartVite();
  return initialServerPromise;
}

fastify.addHook("onRequest", async (request, reply) => {
  // Trigger restart when we see a request for deps/react-router.js
  if (request.url.includes("env.mjs") && !hasTriggeredRestart) {
    console.log(
      `[fastify] TRIGGERING RESTART on ${request.url} - requests will be held until new server is ready`
    );
    hasTriggeredRestart = true;
    // Don't await here - let it start the restart, then this request will be held below
    restartVite();
  }

  // If restart in progress, hold this request
  if (restartPromise) {
    console.log(`[fastify] Holding request ${request.url} during restart...`);
    await new Promise<void>((resolve) => {
      pendingHttpRequests.push(resolve);
    });
    console.log(`[fastify] Releasing held request ${request.url}`);
  }

  // Ensure first server is started (lazy init)
  await ensureFirstServer();

  // Now attach the current active server to the request
  request.viteServer = activeVite!;
  request.serverBuild = await getServerBuild(activeVite!);

  console.log(`[fastify] ${request.url} -> server #${serverIdCounter}`);
});

fastify.register(fastifyReactRouter);

// HMR WebSocket Proxy on port 3001
// This accepts WebSocket connections from the browser and pipes them to the active HMR port
const hmrProxyServer = http.createServer((req, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("Upgrade Required - This port is for WebSocket connections only");
});

hmrProxyServer.on("upgrade", async (req, socket, head) => {
  console.log(`[hmr-proxy] Upgrading WebSocket connection from ${req.url}`);
  
  // If restart in progress, hold this connection
  if (restartPromise) {
    console.log(`[hmr-proxy] Holding WebSocket connection during restart...`);
    await new Promise<void>((resolve) => {
      pendingWsConnections.push({ socket, head, resolve });
    });
    console.log(`[hmr-proxy] Releasing held WebSocket connection`);
  }

  const targetPort = activeHmrPort;
  if (!targetPort) {
    console.error(`[hmr-proxy] No active HMR port!`);
    socket.destroy();
    return;
  }

  console.log(`[hmr-proxy] Proxying WebSocket to HMR port ${targetPort}`);

  // Connect to the real HMR server
  const targetSocket = net.connect(targetPort, "127.0.0.1", () => {
    console.log(`[hmr-proxy] Connected to target HMR server on port ${targetPort}`);
    
    // Forward the original HTTP upgrade request
    const requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n");

    targetSocket.write(requestLine + headers + "\r\n\r\n");
    if (head.length > 0) {
      targetSocket.write(head);
    }

    // Pipe data between sockets
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on("error", (err) => {
    console.error(`[hmr-proxy] Target socket error:`, err.message);
    socket.destroy();
  });

  socket.on("error", (err) => {
    console.error(`[hmr-proxy] Client socket error:`, err.message);
    targetSocket.destroy();
  });

  socket.on("close", () => {
    targetSocket.destroy();
  });

  targetSocket.on("close", () => {
    socket.destroy();
  });
});

// Start everything
async function main() {
  console.log("[server] Starting Fastify (Vite will start on first request)...");

  await fastify.listen({ port: 3000 });
  console.log(`[server] Fastify listening on port 3000`);

  hmrProxyServer.listen(HMR_PROXY_PORT, () => {
    console.log(`[server] HMR WebSocket proxy listening on port ${HMR_PROXY_PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
