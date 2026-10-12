import fs from "node:fs";
import path from "node:path";

/**
 * Cloudflare Workers (workerd) cannot run native C++ Node addons (.node binaries).
 * Next.js references `sharp` for image optimization, which prompts bundlers like
 * esbuild to trace and fail on sharp's native platform-specific binaries.
 *
 * This script safely stubs `sharp.cjs` across node_modules so that OpenNext's
 * esbuild bundling succeeds seamlessly on both Windows and Linux CI environments.
 */
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.name === "sharp.cjs") {
      const content = fs.readFileSync(fullPath, "utf8");
      if (content.includes(".node")) {
        fs.writeFileSync(
          fullPath,
          'module.exports = function sharp() { throw new Error("sharp is disabled in Cloudflare Workers"); };\n'
        );
        console.log(`[stub-sharp] Successfully stubbed ${fullPath}`);
      }
    }
  }
}

walk("node_modules");
