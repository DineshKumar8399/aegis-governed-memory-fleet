import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pg` and the AWS SDK are Node-only. Keep them out of the bundler's
  // module graph so route handlers load the real native/CJS implementations.
  serverExternalPackages: ["pg", "pg-native"],
  experimental: {
    // Route handlers hit Bedrock + CockroachDB; give them room.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
