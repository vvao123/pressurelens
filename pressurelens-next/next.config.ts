import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
   eslint: {
      // Prevent Vercel next build from failing on ESLint errors
      ignoreDuringBuilds: true,
    },
   turbopack: {
      root: path.join(__dirname),
   },
   // Allow loading dev assets (HMR, /_next/*, etc.) from these dev origins
   allowedDevOrigins: ['*.trycloudflare.com'], // Current cloudflared tunnel
};




export default nextConfig;
