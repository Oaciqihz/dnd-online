import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DnD Online · 多人跑团",
  description: "建一个房间，把朋友拉进来一起跑团。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
