/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript-built ESM; Next needs to bundle them.
  transpilePackages: [
    '@rawedit/core',
    '@rawedit/db',
    '@rawedit/storage',
    '@rawedit/queue',
    '@rawedit/imports',
  ],
  serverExternalPackages: ['postgres', 'ioredis', 'bullmq'],
  experimental: {
    // Multipart uploads go browser -> R2; nothing large ever passes through a route.
    serverActions: { bodySizeLimit: '2mb' },
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
