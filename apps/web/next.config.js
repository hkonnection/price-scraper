/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable edge runtime for Cloudflare Pages
  experimental: {
    runtime: 'edge',
  },
};

module.exports = nextConfig;
