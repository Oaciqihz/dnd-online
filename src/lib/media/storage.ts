import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 图片存储。
 *
 * 这里刻意做了一层 provider 抽象，不是过度设计 —— 因为「免费图床」这个词
 * 本身就不含任何承诺。它们可能明天关停、可能限流、可能被墙、可能改条款。
 * 如果业务代码直接写死 `fetch("https://api.imgbb.com/...")`，
 * 那更换供应商就意味着改路由、改数据库、担心老数据裂图。
 *
 * 抽象之后，更换供应商只需要动这个文件 + 改一个环境变量。
 *
 * 关键设计：**库里存的是「能直接放进 <img src> 的地址」，不是供应商的内部 id。**
 *
 * - 本地：存 `p_ab12.webp`，读取时拼成 `/media/p_ab12.webp`
 * - 云图床：存它返回的完整 https 地址，读取时原样用
 *
 * 看起来不统一，但这个不统一是有意为之的。如果统一成「自己的 key + 反查供应商」，
 * 换供应商时全表数据都要迁移，而且迁移期间必然有一批图裂掉。
 * 存可直接使用的地址，老图永远不失效，换供应商只是「新图走新的」——
 * 这是渐进迁移，不是停机迁移。
 */

export type PutResult =
  | { ok: true; ref: string }
  | { ok: false; error: string };

/**
 * 用途。目前只有两种，但分开不是为了分类，是为了**排查**：
 * 本地 key 首位和云图床的 public_id 前缀都从这里来。
 * 以后「这堆图是什么占的额度」就成了一个能直接答的问题。
 */
export type MediaKind = "portrait" | "scene";

export type MediaStore = {
  name: string;
  /** data 已经是处理好的 webp 字节，不要再在这里做图像处理 */
  put(input: { data: Buffer; hint: string; kind?: MediaKind }): Promise<PutResult>;
  /** 尽力删除。云图床的 unsigned 上传拿不到删除权限，见各实现的说明 */
  remove(ref: string): Promise<void>;
};

/**
 * 上传体积上限。
 *
 * 定义在 ref.ts 里（那个文件没有 node 依赖，客户端也能读），
 * 这里只做转出，免得调用方要记两个模块名。
 */
export { MAX_MAP_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from "./ref";

/**
 * 上传目录。
 *
 * 写成 `join(cwd, "data", "uploads")` 而不是 `resolve(cwd, 环境变量 ?? 默认)`，
 * 是因为构建期的静态分析看到「路径来自环境变量」就会放弃推断，
 * 转而把整个项目（含 public/）打进 server 输出，部署包会莫名其妙地变大。
 * 拆成两段之后默认路径是静态可推断的，只有显式配置 MEDIA_DIR 时才动态。
 */
const UPLOAD_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.join(process.cwd(), "data", "uploads");

/** 首位标记用途：p = portrait，s = scene */
const KIND_PREFIX: Record<MediaKind, string> = {
  portrait: "p",
  scene: "s",
};

function newKey(kind: MediaKind): string {
  return `${KIND_PREFIX[kind]}_${randomUUID().replace(/-/g, "").slice(0, 16)}.webp`;
}

/** 只认我们自己生成的 key 形状，避免 remove 时被传入路径穿越 */
function isLocalKey(ref: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(ref) && !ref.includes("..");
}

/* ------------------------------------------------------------------ 本地 */

/**
 * 本地磁盘。
 *
 * 默认走这个。好处是零配置、零网络、断网也能开发；
 * 坏处是文件在服务器上，多实例部署时彼此看不到，也没有 CDN。
 *
 * 对「自己跑一个跑团工具」来说这个坏处无关紧要，
 * 对「做成公开服务」来说它是第一个要换掉的东西。
 */
const localStore: MediaStore = {
  name: "local",

  async put({ data, kind = "portrait" }) {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });

      const key = newKey(kind);
      // wx：文件已存在就报错。key 是 16 位随机十六进制，
      // 碰撞概率可以忽略，但用 wx 能让「万一撞了」变成显式错误而不是静默覆盖别人的图
      await fs.writeFile(path.join(UPLOAD_DIR, key), data, { flag: "wx" });

      return { ok: true, ref: key };
    } catch (error) {
      console.error("[media] 本地写入失败", error);
      return { ok: false, error: "保存图片失败，请重试" };
    }
  },

  async remove(ref) {
    if (!isLocalKey(ref)) return;

    try {
      await fs.unlink(path.join(UPLOAD_DIR, ref));
    } catch (error) {
      // 文件本来就不在，等于已经删掉了。
      // 这里不能往上抛：删旧图失败不应该让「换新图」这件事整体失败
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[media] 本地删除失败", error);
      }
    }
  },
};

/* ------------------------------------------------------- Cloudinary */

/**
 * Cloudinary 的 unsigned upload。
 *
 * 选它而不是别家，主要因为它的免费额度是「一个数字管三件事」——
 * 25 credits/月，1 credit = 1000 次变换 / 1GB 存储 / 1GB 流量。
 * 对头像这种场景，一个 512×512 webp 只要几十 KB，25 credits 能用很久。
 *
 * 注意用的是 **unsigned** preset：preset 名本身可以公开，
 * 真正的安全边界在我们自己的服务端路由（校验登录、校验属主、限制体积），
 * 而不是在 Cloudinary 的密钥上。所以这里不需要 API Secret，
 * 也就不存在「密钥泄露」这回事。
 */
const cloudinaryStore: MediaStore = {
  name: "cloudinary",

  async put({ data, hint, kind = "portrait" }) {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    const preset = process.env.CLOUDINARY_UPLOAD_PRESET;

    if (!cloud || !preset) {
      return {
        ok: false,
        error: "还没配置 Cloudinary（CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET）",
      };
    }

    try {
      const form = new FormData();
      // Cloudinary 接受 data URI 形式的 base64，省掉一次 multipart 文件流
      form.append("file", `data:image/webp;base64,${data.toString("base64")}`);
      form.append("upload_preset", preset);
      // public_id 里带上用途和来源，出问题时能在 Cloudinary 后台一眼认出是谁传的
      form.append("public_id", `${kind}_${hint}_${randomUUID().slice(0, 8)}`);

      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`,
        { method: "POST", body: form },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error("[media] Cloudinary 上传失败", response.status, text.slice(0, 300));
        return { ok: false, error: `图床返回 ${response.status}，请稍后重试` };
      }

      const json = (await response.json()) as { secure_url?: string };
      if (!json.secure_url) return { ok: false, error: "图床没有返回图片地址" };

      return { ok: true, ref: json.secure_url };
    } catch (error) {
      console.error("[media] Cloudinary 请求异常", error);
      return { ok: false, error: "连不上图床，请稍后重试" };
    }
  },

  async remove() {
    // unsigned 上传没有删除权限（删除需要 API Key + 签名）。
    // 所以这里只是把数据库里的引用清掉，远端文件会留在 Cloudinary 后台。
    // 对一个跑团工具的体量来说这是可接受的：图片几十 KB，免费额度不是瓶颈。
    // 真要认真清理，就得加 API Secret 并实现 destroy 签名 —— 那也意味着
    // 服务端多一个必须保管的秘密，和「unsigned 换简单」是一个取舍。
  },
};

/* ------------------------------------------------------------- ImgBB */

/**
 * ImgBB。存储和流量都不设上限，唯一的限制是单图 32MB。
 *
 * 需要 API Key，所以它只能跑在服务端 —— 一旦这个 key 出现在浏览器里，
 * 任何人都能拿它发图，最后一圈都算在你账上。这也是为什么上传接口
 * 必须是「前端传给我们、我们再传给它」，而不是前端直传。
 */
const imgbbStore: MediaStore = {
  name: "imgbb",

  async put({ data }) {
    const key = process.env.IMGBB_API_KEY;
    if (!key) return { ok: false, error: "还没配置 ImgBB（IMGBB_API_KEY）" };

    try {
      const form = new FormData();
      // ImgBB 的 base64 不能带 data: 前缀
      form.append("image", data.toString("base64"));

      const response = await fetch(
        `https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`,
        { method: "POST", body: form },
      );

      if (!response.ok) {
        console.error("[media] ImgBB 上传失败", response.status);
        return { ok: false, error: `图床返回 ${response.status}，请稍后重试` };
      }

      const json = (await response.json()) as {
        data?: { url?: string; display_url?: string };
      };

      const url = json.data?.url ?? json.data?.display_url;
      if (!url) return { ok: false, error: "图床没有返回图片地址" };

      return { ok: true, ref: url };
    } catch (error) {
      console.error("[media] ImgBB 请求异常", error);
      return { ok: false, error: "连不上图床，请稍后重试" };
    }
  },

  async remove() {
    // ImgBB 会返回一个 delete_url，但那是一个带 token 的页面地址。
    // 要支持删除就得把它一起存进数据库，而那个地址本身等于删除权 ——
    // 存在角色卡里、跟着 room:state 广播出去是不可能接受的。
    // 所以这里不删，引用清掉即可。
  },
};

/* --------------------------------------------------------------- 工厂 */

/**
 * 每次调用都重新读一次环境变量。
 *
 * 不做模块级常量：dev 模式下改了 .env 之后热更新会重新执行模块，
 * 但如果有别的地方缓存了 store，就会一直用旧配置 ——
 * 这种「改了半天没生效」的问题排查起来最耗时。
 */
export function getMediaStore(): MediaStore {
  const name = (process.env.MEDIA_PROVIDER ?? "local").trim().toLowerCase();

  if (name === "cloudinary") return cloudinaryStore;
  if (name === "imgbb") return imgbbStore;
  return localStore;
}

/** 本地文件的真实路径。只有 /media 路由用得到 */
export function localMediaPath(key: string): string | null {
  if (!isLocalKey(key)) return null;
  return path.join(UPLOAD_DIR, key);
}
