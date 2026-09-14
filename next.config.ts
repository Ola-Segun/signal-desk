import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    /**
     * Pin the workspace root. Without this, Turbopack walks up the filesystem
     * looking for a lockfile and can latch onto an unrelated one outside the
     * repository, which makes builds depend on where the project happens to sit
     * on disk.
     */
    root: path.resolve(import.meta.dirname),
  },
};

export default nextConfig;
