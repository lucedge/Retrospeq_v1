import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app is nested inside E:\LuceEdge, which has its own
  // package-lock.json from the separate, unrelated LuceEdge project.
  // Pin the workspace root so Turbopack doesn't infer the parent dir.
  turbopack: {
    root: __dirname,
  },
  // This dev machine has 12 cores but only ~5-6GB free RAM under typical
  // load, so `npm run build`'s default worker count (os.cpus().length - 1
  // = 11) reliably OOM-crashes during "Collecting page data" (host-level
  // Zone Allocation / STATUS_ACCESS_VIOLATION, not a code defect -- the
  // TypeScript compile phase always passes first). Confirmed independently
  // 4+ times across separate coder/tester/security-reviewer/qa dispatches
  // on 2026-09-08/09 (see PROGRESS.md, search "experimental.cpus"): every
  // single one of those diagnostic builds passed cleanly on the first
  // attempt once capped to 2 workers, after the uncapped default failed
  // repeatedly on the same host in the same session. Making the workaround
  // permanent instead of leaving every future dispatch to rediscover it.
  experimental: {
    cpus: 2,
  },
};

export default nextConfig;
