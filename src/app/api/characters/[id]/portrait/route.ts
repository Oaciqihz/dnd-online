import sharp from "sharp";
import { getCurrentUser } from "@/lib/auth";
import {
  getOwnedCharacter,
  saveCharacterPortrait,
} from "@/lib/characters";
import {
  getMediaStore,
  MAX_UPLOAD_BYTES,
} from "@/lib/media/storage";
import {
  hasUploadedImage,
  parsePortrait,
  sanitizePortrait,
  type Portrait,
} from "@/lib/portrait";
import { findRoomCodesUsingCharacter } from "@/lib/rooms";
import { notifyRoomRefresh } from "@/lib/socket-notify";

/**
 * 角色立绘的上传 / 移除。
 *
 * 为什么不走 Server Action：Server Action 的请求体默认有 1MB 限制，
 * 而且它擅长的是「表单字段 → 数据库」，不擅长接收二进制。
 * 传图片天然是 multipart + 大 body，用 route handler 更直接，
 * 也能自己控制「太大就直接 413」而不必让框架先把整个 body 读完。
 *
 * 安全上的三道关，缺一不可：
 *
 * 1. 登录 + 属主。上传是写操作，必须先确认「你是谁」和「这张卡是不是你的」。
 *    只查登录不查属主的话，改一下 URL 里的 id 就能把别人的立绘换掉。
 *
 * 2. 大小。在读文件之前就挡掉，避免有人用 200MB 的文件把内存吃满。
 *
 * 3. 真的是一张图。这一关交给 sharp 解码：解不出来就不是图片。
 *    绝不能信 file.type（浏览器按扩展名猜，随便伪造），
 *    也不能信扩展名 —— 一个 .jpg 里可以放任意字节。
 *    解码成功之后立刻重编码成 512×512 webp：
 *    - 统一了格式，前端不用考虑动图 / 巨图 / CMYK
 *    - 顺带剥离 EXIF，玩家传的手机照片不会带着 GPS 坐标进数据库
 *    - 尺寸归一化，舞台上二十个棋子不会因为图源不同而参差不齐
 */

const AVATAR_SIZE = 512;
/** 太小的图放大到 512 会糊成一团，不如直接拒绝并告诉玩家换一张 */
const MIN_SOURCE_SIZE = 64;
/** 防止解压炸弹：一张 50000×50000 的 PNG 只有几百 KB，解码却要几十 GB 内存 */
const MAX_INPUT_PIXELS = 40_000_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return json({ ok: false, error: "登录状态已失效" }, 401);

  const row = await getOwnedCharacter(id, user.id);
  if (!row) return json({ ok: false, error: "找不到这张角色卡" }, 404);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "请求格式不对" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "没有收到图片" }, 400);
  }

  if (file.size === 0) return json({ ok: false, error: "图片是空的" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return json(
      { ok: false, error: `图片不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB` },
      413,
    );
  }

  const input = Buffer.from(await file.arrayBuffer());

  let webp: Buffer;
  try {
    const image = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
      // 必须显式关掉：默认会按 EXIF 里的 orientation 做一次隐式旋转，
      // 再叠加下面的 .rotate() 就会把竖拍照片转两遍
      autoOrient: false,
    });

    const meta = await image.metadata();

    if (!meta.width || !meta.height) {
      return json({ ok: false, error: "读不出这张图的尺寸" }, 400);
    }

    if (Math.min(meta.width, meta.height) < MIN_SOURCE_SIZE) {
      return json(
        { ok: false, error: `图片太小了（${meta.width}×${meta.height}），至少 ${MIN_SOURCE_SIZE}×${MIN_SOURCE_SIZE}` },
        400,
      );
    }

    webp = await image
      // 按 EXIF 把竖拍照片转正，否则手机拍的图有一半是躺着的
      .rotate()
      // attention：让 sharp 自己找画面里最值得保留的区域来裁剪。
      // 对人物头像来说它基本都能把脸留在中间，比直接居中裁好得多
      .resize(AVATAR_SIZE, AVATAR_SIZE, {
        fit: "cover",
        position: "attention",
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (error) {
    console.error("[portrait] 解码失败", error);
    return json({ ok: false, error: "这不是一张能识别的图片" }, 400);
  }

  const store = getMediaStore();
  const stored = await store.put({ data: webp, hint: id.slice(0, 8) });

  if (!stored.ok) return json({ ok: false, error: stored.error }, 502);

  // 表单里可能带着玩家刚调好的风格 / 边框。
  // 优先用前端传来的，因为玩家很可能「先挑了边框，再传图」——
  // 如果这里直接用数据库里的旧配置，他刚挑的边框会被无声地冲掉。
  // 传上来的东西照样要过白名单（sanitizePortrait），和直接改库没有区别。
  const previous = parsePortrait(row.portrait, row.name || row.id);
  const base = readSubmittedPortrait(form, previous);

  const next = sanitizePortrait({ ...base, image: stored.ref }, previous.seed);

  const saved = await saveCharacterPortrait(id, user.id, next);
  if (!saved.ok) {
    // 入库失败就把刚传上去的文件删掉，别留一个永远没人引用的孤儿文件
    await store.remove(stored.ref);
    return json({ ok: false, error: saved.error }, 500);
  }

  // 老图要在入库成功之后再删 —— 反过来会有「旧图删了、新图没存上」的空窗
  if (hasUploadedImage(previous) && previous.image !== stored.ref) {
    await store.remove(previous.image);
  }

  await notifyRooms(id);

  return json({ ok: true, portrait: saved.portrait });
}

/**
 * 移除图片，退回生成式头像。
 *
 * 单独成一个方法而不是「POST 一个空 file」，是为了让语义清楚：
 * 玩家点「用生成的」和「上传失败」是两件完全不同的事。
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return json({ ok: false, error: "登录状态已失效" }, 401);

  const row = await getOwnedCharacter(id, user.id);
  if (!row) return json({ ok: false, error: "找不到这张角色卡" }, 404);

  const current = parsePortrait(row.portrait, row.name || row.id);
  const next = sanitizePortrait(
    { ...current, image: "" },
    row.name || row.id,
  );

  const saved = await saveCharacterPortrait(id, user.id, next);
  if (!saved.ok) return json({ ok: false, error: saved.error }, 500);

  if (hasUploadedImage(current)) {
    await getMediaStore().remove(current.image);
  }

  await notifyRooms(id);

  return json({ ok: true, portrait: saved.portrait });
}

/**
 * 前端可能附带一份「当前的」形象配置（风格 / 种子 / 边框）。
 *
 * 解析失败就用数据库里那份，不报错 —— 这个字段是可选的锦上添花，
 * 让它导致整个上传失败是不划算的。
 */
function readSubmittedPortrait(form: FormData, fallback: Portrait): Portrait {
  const raw = form.get("portrait");
  if (typeof raw !== "string" || !raw) return fallback;

  try {
    // 解析出来的东西不直接用，下面还会过一遍 sanitizePortrait
    return sanitizePortrait(JSON.parse(raw), fallback.seed);
  } catch {
    return fallback;
  }
}

/**
 * 这张卡可能正摆在某个房间里。改了形象要让那边的人立刻看到，
 * 否则别人眼里你还是老样子，直到下次刷新房间页。
 */
async function notifyRooms(characterId: string): Promise<void> {
  const codes = await findRoomCodesUsingCharacter(characterId);
  await Promise.all(codes.map((code) => notifyRoomRefresh(code)));
}
