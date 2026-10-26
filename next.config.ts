import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，必须交给 Node 直接 require，不能让打包器处理
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
