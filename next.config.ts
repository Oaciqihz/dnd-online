import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 和 sharp 都是原生模块，必须交给 Node 直接 require，
  // 不能让打包器处理。sharp 平时是 Next 自己在用（图片优化），
  // 但我们在上传接口里直接 import 了它，所以也要显式列出来。
  serverExternalPackages: ["better-sqlite3", "sharp"],
};

export default nextConfig;
