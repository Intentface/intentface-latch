import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native module: keep it out of the bundle.
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
