import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Serves /api from server/app.ts inside the dev server: one process, one port. */
const api = (): Plugin => ({
  name: "knowledge-example-api",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next();
      try {
        const { handleNode } = (await server.ssrLoadModule("/server/app.ts")) as typeof import("./server/app.js");
        if (!(await handleNode(req, res))) next();
      } catch (e) {
        next(e);
      }
    });
  },
});

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  return { plugins: [react(), api()], server: { port: 5180 } };
});
