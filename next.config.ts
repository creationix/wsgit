import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@ws-git/protocol", "@ws-git/server"],
  serverExternalPackages: ["lz4-napi", "better-sqlite3", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
};

export default nextConfig;
