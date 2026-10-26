import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  SESSION_COOKIE,
  findUserByToken,
  type SessionUser,
} from "../src/lib/session-store";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../src/lib/protocol";

const PORT = Number(process.env.SOCKET_PORT ?? 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const httpServer = createServer();

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>(httpServer, {
  cors: {
    origin: WEB_ORIGIN,
    credentials: true, // 必须开，否则浏览器不会带 cookie 完成握手
  },
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
    next();
  } catch (error) {
    console.error("[socket] 认证过程出错", error);
    next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  const user: SessionUser = socket.data.user;
  console.log(
    `[socket] + ${user.displayName} (${socket.id}) 当前在线 ${io.engine.clientsCount}`,
  );

  socket.emit("session:ready", { user, serverTime: Date.now() });

  socket.on("ping:check", (ack) => {
    if (typeof ack === "function") ack({ pong: Date.now() });
  });

  socket.on("disconnect", (reason) => {
    console.log(
      `[socket] - ${user.displayName} (${reason}) 当前在线 ${io.engine.clientsCount}`,
    );
  });
});

/** 健康检查。部署到 Railway / Fly.io 时这个接口会被平台反复探测。 */
httpServer.on("request", (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        online: io.engine.clientsCount,
        uptimeSeconds: Math.round(process.uptime()),
      }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`[socket] 实时服务已启动 http://localhost:${PORT}`);
  console.log(`[socket] 允许来源 ${WEB_ORIGIN}`);
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
