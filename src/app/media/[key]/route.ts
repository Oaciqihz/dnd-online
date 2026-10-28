import fs from "node:fs/promises";
import { localMediaPath } from "@/lib/media/storage";

/**
 * 本地图片的出口。
 *
 * 为什么不放进 public/：public 里的文件是构建产物的一部分，
 * 运行时写进去的文件在 dev 下能读到，但在 production 的 standalone 输出里
 * 未必在预期位置，而且它和「构建产物」混在一起，清缓存时容易连用户数据一起清掉。
 * 放在 data/uploads 并由这里读出来，数据的归属是清楚的。
 *
 * 缓存策略：key 是内容随机名（p_ + 16 位十六进制），同一个 key 的内容永远不会变，
 * 所以可以给一年 + immutable。玩家换图会得到一个新 key，
 * 浏览器不会拿着旧缓存显示旧头像。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;

  // localMediaPath 内部已经做了形状校验（不含 ..、不含 /），
  // 返回 null 表示这不是一个合法的本地 key —— 可能是云图床的地址被误请求到了这里
  const filePath = localMediaPath(decodeURIComponent(key));
  if (!filePath) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const data = await fs.readFile(filePath);

    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(data.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
