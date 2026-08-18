import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app is nested inside E:\LuceEdge, which has its own
  // package-lock.json from the separate, unrelated LuceEdge project.
  // Pin the workspace root so Turbopack doesn't infer the parent dir.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
