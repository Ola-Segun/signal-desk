import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import type { OpenNextConfig } from "@opennextjs/cloudflare";

// `buildCommand` lives on the underlying OpenNextConfig (from @opennextjs/aws)
// but is not re-exported in CloudflareOverrides. We cast through OpenNextConfig
// to set it explicitly so that opennextjs-cloudflare calls `next build` directly
// instead of `pnpm build` (which would re-enter itself and loop).
const config = defineCloudflareConfig() as OpenNextConfig & {
  buildCommand?: string;
};
config.buildCommand = "pnpm run build:next";

export default config;
