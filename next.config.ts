import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ws-git/protocol", "@ws-git/server"],
  serverExternalPackages: ["lz4-napi", "better-sqlite3"],
};

export default nextConfig;
