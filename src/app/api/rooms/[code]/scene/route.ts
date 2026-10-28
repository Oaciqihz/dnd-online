import sharp from "sharp";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import {
  getMediaStore,
  MAX_MAP_UPLOAD_BYTES,
} from "@/lib/media/storage";
import {
  clearRoomBackgroundImage,
  normalizeRoomCode,
  setRoomBackgroundImage,
} from "@/lib/rooms";
import { notifyRoomRefresh } from "@/lib/socket-notify";

/**
 * DM 上传舞台地图。
 *
 * 和角色立绘走的是同一套骨架（登录 → 权限 → 体积 → sharp 真实解码 →
 * 重编码 → 入库 → 删旧图 → 广播），但有三处必须不同：
 *
 * 1. **不裁切。** 头像是圆形徽章，任何比例都能裁成 1:1；
 *    地图是信息载体，裁掉一条边就是裁掉半条走廊。所以这里只缩不裁，
 *    保留原始比例，由 backgroundFit 决定显示时怎么填。
 *
 * 2. **体积上限放宽到 8MB。** 一张 1080p 的方格战术图动辄 5-6MB。
 *    沿用头像的 2MB 会把大多数地图直接挡在门外。
 *
 * 3. **拒绝动图。** sharp 会把 GIF 取第一帧，静默成功。
 *    但 DM 传一张动图上来是期待它动的，最后看到一张静止的图只会以为
 *    是自己传错了。不如明确告诉他。
 */

const MAP_MAX_EDGE = 1920;
/** 太小的图铺满全屏会糊成一片，不如拒绝 */
const MIN_MAP_EDGE = 320;
/** 解压炸弹防线：一张 50000×50000 的 PNG 只有几百 KB，解码却要几十 GB */
const MAX_INPUT_PIXELS = 40_000_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * 兜一层未预期异常。
 *
 * 不兜的话，任何一处疏忽都会变成「500 + 空 body」——
 * DM 那边看到的是上传按钮转圈然后什么都没发生，我们这边什么也看不到。
 * 至少让响应体里有一句人话，控制台里有完整堆栈。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    return await handlePost(request, params);
  } catch (error) {
    console.error("[scene] 上传异常", error);
    return json({ ok: false, error: "服务器出错了，请稍后重试" }, 500);
  }
}

async function handlePost(
  request: Request,
  paramsPromise: Promise<{ code: string }>,
): Promise<Response> {
  const { code: rawCode } = await paramsPromise;
  const code = normalizeRoomCode(rawCode);

  const user = await getCurrentUser();
  if (!user) return json({ ok: false, error: "登录状态已失效" }, 401);

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
  if (file.size > MAX_MAP_UPLOAD_BYTES) {
    return json(
      {
        ok: false,
        error: `地图不能超过 ${Math.round(MAX_MAP_UPLOAD_BYTES / 1024 / 1024)}MB`,
      },
      413,
    );
  }

  const input = Buffer.from(await file.arrayBuffer());

  let webp: Buffer;
  try {
    const image = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      animated: false,
      // 同 portrait：默认会按 EXIF 做一次隐式旋转，再叠加 .rotate() 就转两遍
      autoOrient: false,
    });

    const meta = await image.metadata();

    if (!meta.width || !meta.height) {
      return json({ ok: false, error: "读不出这张图的尺寸" }, 400);
    }

    if (meta.pages && meta.pages > 1) {
      return json(
        { ok: false, error: "地图不能是动图，请上传静态图片" },
        400,
      );
    }

    if (Math.max(meta.width, meta.height) < MIN_MAP_EDGE) {
      return json(
        {
          ok: false,
          error: `地图太小了（${meta.width}×${meta.height}），长边至少 ${MIN_MAP_EDGE}px`,
        },
        400,
      );
    }

    webp = await image
      .rotate()
      // fit: "inside" 让 sharp 自己按比例缩进 1920×1920 的框里，
      // 不裁切、也不放大 —— 所以这里不需要知道旋转后的实际宽高比
      .resize({
        width: MAP_MAX_EDGE,
        height: MAP_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      // 地图细节多，压太狠会把格子线糊掉，所以比头像的 82 高一点
      .webp({ quality: 86, effort: 4 })
      .toBuffer();
  } catch (error) {
    console.error("[scene] 解码失败", error);
    return json({ ok: false, error: "这不是一张能识别的图片" }, 400);
  }

  const store = getMediaStore();
  const stored = await store.put({
    data: webp,
    hint: code,
    kind: "scene",
  });

  if (!stored.ok) return json({ ok: false, error: stored.error }, 502);

  const result = await setRoomBackgroundImage(
    user.id,
    code,
    stored.ref,
    form.get("fit"),
  );

  if (!result.ok) {
    // 没写进库就删掉刚传的文件，别留一个永远没人引用的孤儿
    await store.remove(stored.ref);
    return json({ ok: false, error: result.error }, 400);
  }

  // 旧图在新图入库之后才删 —— 反过来会有「旧图删了、新图没存上」的空窗
  if (result.removedImage && result.removedImage !== stored.ref) {
    await store.remove(result.removedImage);
  }

  await notifyRoomRefresh(code);
  revalidatePath(`/rooms/${code}`);

  return json({
    ok: true,
    backgroundKey: result.backgroundKey,
    backgroundImage: result.backgroundImage,
    backgroundFit: result.backgroundFit,
    sceneCaption: result.sceneCaption,
  });
}

/**
 * 移除地图，退回内置渐变。
 *
 * 只清 image，不动 backgroundKey —— DM 刚选好的场景底色不该被
 * 「我把图撤了」这件事顺手改掉。
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);

  const user = await getCurrentUser();
  if (!user) return json({ ok: false, error: "登录状态已失效" }, 401);

  const result = await clearRoomBackgroundImage(user.id, code);
  if (!result.ok) return json({ ok: false, error: result.error }, 400);

  if (result.removedImage) {
    await getMediaStore().remove(result.removedImage);
  }

  await notifyRoomRefresh(code);
  revalidatePath(`/rooms/${code}`);

  return json({
    ok: true,
    backgroundKey: result.backgroundKey,
    backgroundImage: "",
    backgroundFit: result.backgroundFit,
    sceneCaption: result.sceneCaption,
  });
}
