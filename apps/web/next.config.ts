import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Standalone output (used by the Dockerfile) makes the image small and self-contained.
  // `next start` does not support it, so it is only enabled when the build asks for it.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Monorepo: trace files from the repo root so workspace packages are included.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  serverExternalPackages: ["@modelcontextprotocol/sdk"]
};

export default nextConfig;
