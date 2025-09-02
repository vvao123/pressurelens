import type { NextConfig } from "next";

const nextConfig: NextConfig = {
   // 允许从这些“开发访问域名”加载开发资产（HMR、/_next/* 等）
   allowedDevOrigins: ['*.trycloudflare.com'], // 你现在用的 cloudflared 隧道
};




export default nextConfig;
