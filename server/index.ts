import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "socket.io";
import {
  SESSION_COOKIE,
  findUserByToken,
  type SessionUser,
} from "../src/lib/session-store";
import {
  getRoomByCode,
  isRoomMember,
  listRoomMembers,
  normalizeRoomCode,
  toMemberView,
} from "../src/lib/rooms";
import { INTERNAL_TOKEN, INTERNAL_TOKEN_HEADER } from "../src/lib/internal-auth";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../src/lib/protocol";

const PORT = Number(process.env.SOCKET_PORT ?? 3001);

/**
 * 允许的连接来源。
 *
 * 开发时用 localhost:3000 和 127.0.0.1:3000 打开页面，浏览器发出的 Origin
 * 是两个不同的字符串。只写其中一个，另一种访问方式握手就会被拒。
 * 所以默认把三个本机地址都放进来，需要其它来源时用 WEB_ORIGIN 追加（逗号分隔）。
 */
const WEB_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  ...(process.env.WEB_ORIGIN ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
];

const httpServer = createServer();

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>(httpServer, {
  cors: {
    origin: WEB_ORIGINS,
    credentials: true, // 必须开，否则浏览器不会带 cookie 完成握手
  },
  /**
   * 心跳调得比默认值（25s / 20s）激进一些。
   *
   * 默认配置下，一条「客户端已经不在了、但服务端还没察觉」的连接要挂 45 秒
   * 才被回收，这段时间里它仍然算在 io.engine.clientsCount 里，
   * 来回切换页面时看起来就是「当前在线」只增不减。
   * 收到 10s 一次、连续 8s 没响应就判定掉线，18 秒内收干净。
   *
   * 代价是对网络抖动更敏感一点，本地开发完全不是问题。
   */
  pingInterval: 10000,
  pingTimeout: 8000,
});

/** 从原始 Cookie 头里取值。Node 里没有现成的解析器，只有几行，就自己写。 */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return null;
}

/**
 * 握手阶段的认证。
 * 复用和网页完全相同的 session —— 已经登录的人打开页面就能直接连上，
 * 没登录的人连接会被拒绝，客户端会收到 message 为 "unauthorized" 的错误。
 */
io.use(async (socket, next) => {
  try {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    if (!token) {
      next(new Error("unauthorized"));
      return;
    }

    const user = await findUserByToken(token);
    if (!user) {
      next(new Error("unauthorized"));
      return;
    }

    socket.data.user = user;
    socket.data.joinedRooms = [];
    socket.data.connectedAt = Date.now();
    next();
  } catch (error) {
    console.error("[socket] 认证过程出错", error);
    next(new Error("unauthorized"));
  }
});

/**
 * 把房间的「真实成员 + 谁在线」算出来，广播给房间里的所有人。
 *
 * 数据库是成员的唯一事实来源，Socket 连接只决定 online 这个标记。
 * 所以哪怕有人断线、重启、开两个标签页，成员名单也不会错乱。
 */
async function broadcastRoomState(code: string): Promise<void> {
  const room = await getRoomByCode(code);
  if (!room) return;

  const rows = await listRoomMembers(room.id);
  const sockets = await io.in(code).fetchSockets();

  const onlineUserIds = new Set<string>();
  for (const remote of sockets) {
    onlineUserIds.add(remote.data.user.id);
  }

  io.to(code).emit("room:state", {
    code,
    members: rows.map((row) => toMemberView(row, onlineUserIds)),
    serverTime: Date.now(),
  });
}

io.on("connection", (socket) => {
  const user: SessionUser = socket.data.user;
  console.log(
    `[socket] + ${user.displayName} (${socket.id}) 当前在线 ${io.engine.clientsCount}`,
  );

  socket.emit("session:ready", { user, serverTime: Date.now() });

  socket.on("ping:check", (ack) => {
    if (typeof ack === "function") ack({ pong: Date.now() });
  });

  /**
   * 订阅房间的实时通道。
   * 注意这里只做「校验 + 订阅」，不写数据库 ——
   * 加房间是 Server Action 的职责（joinRoom），Socket 只负责推送。
   */
  socket.on("room:join", async ({ code } = { code: "" }, ack) => {
    try {
      const normalized = normalizeRoomCode(String(code ?? ""));
      const room = await getRoomByCode(normalized);

      if (!room) {
        ack?.({ ok: false, error: "房间不存在" });
        return;
      }

      if (!(await isRoomMember(room.id, user.id))) {
        ack?.({ ok: false, error: "你不在这个房间里" });
        return;
      }

      await socket.join(normalized);

      if (!socket.data.joinedRooms.includes(normalized)) {
        socket.data.joinedRooms.push(normalized);
      }

      await broadcastRoomState(normalized);
      ack?.({ ok: true });
    } catch (error) {
      console.error("[socket] room:join 失败", error);
      ack?.({ ok: false, error: "服务器开小差了" });
    }
  });

  socket.on("room:leave", async ({ code } = { code: "" }, ack) => {
    try {
      const normalized = normalizeRoomCode(String(code ?? ""));
      await socket.leave(normalized);
      socket.data.joinedRooms = socket.data.joinedRooms.filter(
        (item) => item !== normalized,
      );
      await broadcastRoomState(normalized);
      ack?.({ ok: true });
    } catch (error) {
      console.error("[socket] room:leave 失败", error);
      ack?.({ ok: false, error: "服务器开小差了" });
    }
  });

  /**
   * 断线时把自己待过的房间重新广播一遍。
   * 这时连接已经不在房间里了，所以其他人会立刻看到这个人变成离线。
   */
  socket.on("disconnect", (reason) => {
    console.log(
      `[socket] - ${user.displayName} (${reason}) 当前在线 ${io.engine.clientsCount}`,
    );

    for (const code of socket.data.joinedRooms) {
      void broadcastRoomState(code).catch((error) => {
        console.error("[socket] 离线广播失败", error);
      });
    }
  });
});

/**
 * 健康检查。部署到 Railway / Fly.io 时这个接口会被平台反复探测。
 *
 * ⚠️ 这里有个必须小心的点：Socket.IO 的轮询握手同样走 httpServer 的 request 事件。
 * 如果对「不是 /health 的请求」无脑回 404，就会和 engine.io 抢着写同一个响应，
 * 抛 ERR_HTTP_HEADERS_SENT 把整个进程掀掉 —— 表现出来就是「实时服务未连接」。
 * 所以必须先认出 Socket.IO 自己的路径，原样放过去，一个字都别写。
 */
const SOCKET_PATH = io.path();

/**
 * 读一个小 JSON 请求体。
 * 内部接口的数据量只有几十字节，不需要流式处理，攒起来一次性解析就够。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return null;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * 内部接口：把某个已从数据库删除的用户赶出房间。
 *
 * 调用方是 Next 进程里的 Server Action（见 src/lib/socket-notify.ts）。
 * 两个进程之间没有共享内存，只能这样通知一次。
 *
 * 这里做了三件事，顺序不能换：
 * 1. 先 emit 通知本人（他还在房间里，才收得到）
 * 2. 再把他从房间频道摘掉，之后再也收不到这个房间的任何广播
 * 3. 最后给剩下的人重算一次成员列表
 */
async function handleInternalKick(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers[INTERNAL_TOKEN_HEADER] !== INTERNAL_TOKEN) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }

  const body = (await readJsonBody(req)) as {
    code?: unknown;
    userId?: unknown;
  } | null;

  const code = normalizeRoomCode(String(body?.code ?? ""));
  const userId = String(body?.userId ?? "");

  if (!code || !userId) {
    sendJson(res, 400, { ok: false, error: "code 和 userId 都必须传" });
    return;
  }

  const room = await getRoomByCode(code);
  if (!room) {
    sendJson(res, 404, { ok: false, error: "房间不存在" });
    return;
  }

  let kicked = 0;

  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user.id !== userId) continue;
    if (!socket.data.joinedRooms.includes(code)) continue;

    socket.emit("room:kicked", {
      code,
      reason: "你已被 DM 移出房间",
    });

    await socket.leave(code);
    socket.data.joinedRooms = socket.data.joinedRooms.filter(
      (item) => item !== code,
    );
    kicked += 1;
  }

  await broadcastRoomState(code);
  sendJson(res, 200, { ok: true, kicked });
}

httpServer.on("request", (req, res) => {
  const url = req.url ?? "/";

  if (url === "/health" || url.startsWith("/health?")) {
    const payload: Record<string, unknown> = {
      ok: true,
      online: io.engine.clientsCount,
      uptimeSeconds: Math.round(process.uptime()),
    };

    // ?detail=1 时把每条连接的明细也带出来，排查「在线数只增不减」用
    if (url.includes("detail=1")) {
      payload.sockets = [...io.sockets.sockets.values()].map((item) => ({
        id: item.id,
        userId: item.data.user.id,
        name: item.data.user.displayName,
        rooms: item.data.joinedRooms,
        transport: item.conn.transport.name,
        aliveSeconds: Math.round(
          (Date.now() - (item.data.connectedAt ?? Date.now())) / 1000,
        ),
      }));
    }

    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (url === "/internal/kick" && req.method === "POST") {
    void handleInternalKick(req, res).catch((error) => {
      console.error("[socket] 内部踢人失败", error);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
    return;
  }

  // Socket.IO 的握手、轮询请求，交给 engine.io 自己处理
  if (url.startsWith(SOCKET_PATH)) return;

  // 兜底：万一响应已经被别的处理逻辑写过，再写一次就会崩
  if (res.headersSent || res.writableEnded) return;

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`[socket] 实时服务已启动 http://localhost:${PORT}`);
  console.log(`[socket] Socket.IO 路径 ${SOCKET_PATH}`);
  console.log(`[socket] 允许来源 ${WEB_ORIGINS.join(", ")}`);
});

/** 优雅关停：先把连接收干净再退出，避免客户端看到一堆异常断开。 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[socket] 收到 ${signal}，正在关闭…`);
    io.close(() => {
      httpServer.close(() => process.exit(0));
    });
  });
}
