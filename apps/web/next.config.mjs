import { setupDevPlatform } from '@cloudflare/next-on-pages/next-dev';

// Set up Cloudflare bindings for local dev
if (process.env.NODE_ENV === 'development') {
  setupDevPlatform();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'west.cocowest1.ca',
      },
    ],
  },
};

export default nextConfig;
