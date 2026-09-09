import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@raw-edit/auth",
    "@raw-edit/config",
    "@raw-edit/contracts",
    "@raw-edit/db",
    "@raw-edit/queue",
    "@raw-edit/storage",
    "@raw-edit/video-core",
  ],
};

export default nextConfig;
