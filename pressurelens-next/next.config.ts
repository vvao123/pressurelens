import type { NextConfig } from "next";

const nextConfig: NextConfig = {
   eslint: {
      // Prevent Vercel next build from failing on ESLint errors
      ignoreDuringBuilds: true,
    },
   // Allow loading dev assets (HMR, /_next/*, etc.) from these dev origins
   allowedDevOrigins: ['*.trycloudflare.com'], // Current cloudflared tunnel
};




export default nextConfig;
