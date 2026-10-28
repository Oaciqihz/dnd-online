import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
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
import {
  getCharacterById,
  getRoomCharacterId,
  listRoomCharacterSummaries,
  resolveCheck,
} from "../src/lib/characters";
import { appendChatMessage, listRecentMessages } from "../src/lib/chat-store";
import {
  rollRequestText,
  rollResultText,
  sanitizeChatBody,
} from "../src/lib/chat";
import { appendRoll } from "../src/lib/rolls";
import { rollRaw } from "../src/lib/dice-roll";
import {
  isNatOne,
  isNatTwenty,
  judgeOutcome,
  pickIndex,
  rollTotal,
  sanitizeDiceSpec,
  type DiceSpec,
} from "../src/lib/dice";
import { INTERNAL_TOKEN, INTERNAL_TOKEN_HEADER } from "../src/lib/internal-auth";
import { defaultPosition } from "../src/lib/stage";
import { resolveRoomScene } from "../src/lib/scenes";
import type {
  ChatEntryKind,
  ChatMessageView,
  ClientToServerEvents,
  RollPendingView,
  RollResultView,
  ServerToClientEvents,
  SocketData,
  TokenPosition,
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
 * 棋子的位置，只存在于这个进程的内存里，**不落库**。
 *
 * 这是刻意的。位置是「这一局的临时摆位」，不是角色的属性。
 * 一旦落库，就要回答一串本来不必回答的问题：
 * 重开一局要不要重置？阶段退回准备要不要清空？玩家换了角色卡，
 * 位置跟人走还是跟卡走？现在这些问题的答案都是「不用管」。
 *
 * 代价是服务重启后棋子回到默认站位。对一个跑团工具来说完全可接受 ——
 * 服务重启本来就已经打断这一局了。
 *
 * 真要持久化的时候，加两列 token_x / token_y 到这个 map 的写法里即可，
 * 上层代码一行都不用动。
 */
const roomPositions = new Map<string, Map<string, { x: number; y: number }>>();

function clampPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 算出这个房间当前所有棋子的位置。
 *
 * 成员进来时补一个默认站位，离开时把它从表里删掉，
 * 这样长时间运行的进程不会攒下一堆已经不在房间里的人。
 */
function syncPositions(code: string, userIds: string[]): TokenPosition[] {
  let map = roomPositions.get(code);
  if (!map) {
    map = new Map();
    roomPositions.set(code, map);
  }

  const present = new Set(userIds);
  for (const key of [...map.keys()]) {
    if (!present.has(key)) map.delete(key);
  }

  for (const userId of userIds) {
    if (map.has(userId)) continue;
    // 用「已经在场的人数」而不是这个人在数组里的下标，
    // 这样半路加入的人也能落在空位上，而不是和现有棋子叠在一起
    const position = defaultPosition(map.size, Math.max(userIds.length, map.size + 1));
    map.set(userId, position);
  }

  return userIds.map((userId) => {
    const point = map?.get(userId) ?? { x: 50, y: 62 };
    return { userId, x: point.x, y: point.y };
  });
}

/**
 * 当前「等谁掷骰」的请求，同样只存内存。
 *
 * 和棋子位置一个道理：它描述的是「此刻谁该动」，不是一局的战绩。
 * 进程重启后失效是**正确**行为 —— 一个五分钟没人理的请求，
 * 没有任何理由在服务重启后突然冒出来。
 *
 * 用房间码做键，于是「一个房间同时只能有一次待掷」这条约束
 * 不是靠 if 判断维持的，而是由数据结构本身保证的。这比事后检查可靠：
 * 检查总有漏掉的路径，而 Map 的键不会重复。
 *
 * 阶段结束、DM 撤销、自然过期都会把它清掉，见 clearPendingRoll。
 */
type PendingRoll = {
  /** 已经拼好的对外形状，广播时直接用，不重复构造 */
  view: RollPendingView;
  roomId: string;
  spec: DiceSpec;
};

const pendingRolls = new Map<string, PendingRoll>();

/**
 * 待掷请求的有效期。
 *
 * 五分钟是「够 DM 说完话、玩家反应过来」和「不会在界面里积灰」之间的折中。
 * 没有这个上限的话，DM 切到别的页面十分钟再回来，
 * 舞台上方还挂着一条「等 xin 掷 d20」，而 xin 早就忘了要掷什么。
 */
const PENDING_ROLL_TTL = 5 * 60 * 1000;

function isPendingExpired(view: RollPendingView): boolean {
  return Date.now() - view.createdAt > PENDING_ROLL_TTL;
}

/** 只读看一眼（join 时补发用），过期就地清掉 */
function peekPendingRoll(code: string): RollPendingView | null {
  const entry = pendingRolls.get(code);
  if (!entry) return null;

  if (isPendingExpired(entry.view)) {
    pendingRolls.delete(code);
    return null;
  }

  return entry.view;
}

/**
 * 清掉待掷并通知房间。返回是否真的清掉了东西，
 * 调用方据此决定还要不要做别的事（比如 ended 阶段顺手收尾）。
 */
function clearPendingRoll(code: string): boolean {
  if (!pendingRolls.delete(code)) return false;
  io.to(code).emit("roll:pending", { code, pending: null });
  return true;
}

/**
 * 把一条系统事件（发起检定 / 掷骰结算）写进聊天时间线并广播。
 *
 * 为什么这些事件必须进聊天，而不是只挂在舞台上：
 * 跑团的信息天然是交织的 ——「我要撬锁」→「过个巧手」→「掷出 18」
 * →「锁开了」。把掷骰单独放一块，等于要求玩家自己在两个区域之间
 * 来回对照时间顺序，而时间顺序恰恰是这一局唯一的故事线。
 *
 * 为什么落库和广播是两件事：
 * 落库失败只影响「刷新后还在不在」，而广播失败是「所有人当场看不到」。
 * 所以整个函数包了 try/catch —— 聊天记录出问题，绝不能把掷骰结算搞挂。
 * 掷骰是这几毫秒里唯一重要的事。
 */
async function postSystemChat(input: {
  code: string;
  roomId: string;
  userId: string;
  kind: "roll-request" | "roll-result";
  body: string;
  payload: RollPendingView | RollResultView;
}): Promise<void> {
  try {
    const saved = await appendChatMessage({
      roomId: input.roomId,
      userId: input.userId,
      body: input.body,
      kind: input.kind,
      payload: input.payload,
    });

    /**
     * name / role / frame 对系统条目来说不参与渲染（那张卡片不显示
     * 「谁说的」，因为它不是人说的），但类型要求它们存在，
     * 所以填一个最有意义的：发起时是被要求的人，结算时是掷骰的人。
     */
    const isResult = input.kind === "roll-result";

    const message: ChatMessageView = {
      id: saved.id,
      userId: input.userId,
      name: isResult
        ? (input.payload as RollResultView).actorName
        : (input.payload as RollPendingView).targetName,
      role: isResult ? (input.payload as RollResultView).actorRole : "player",
      frame: isResult ? (input.payload as RollResultView).actorFrame : null,
      body: input.body,
      createdAt: saved.createdAt,
      kind: input.kind,
      request: isResult ? null : (input.payload as RollPendingView),
      roll: isResult ? (input.payload as RollResultView) : null,
    };

    io.to(input.code).emit("chat:message", { code: input.code, message });
  } catch (error) {
    console.error("[socket] 系统消息没进聊天记录", error);
  }
}

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
  // 角色卡摘要随成员列表一起下发。这里放的只能是公开字段，
  // 因为这条广播发给房间里的每一个人，DM 和其他玩家收到的是同一份数据。
  const characterByUser = await listRoomCharacterSummaries(room.id);
  const sockets = await io.in(code).fetchSockets();

  const onlineUserIds = new Set<string>();
  for (const remote of sockets) {
    onlineUserIds.add(remote.data.user.id);
  }

  const positions = syncPositions(
    code,
    rows.map((row) => row.userId),
  );

  // 过一遍 resolveRoomScene 而不是直接把列塞进广播：
  // 广播是发给整个房间的，库里的值哪怕是手工改脏的，也不该原样流出去。
  // 这一步顺带把「key / image / fit 三者怎么组合」收敛到唯一一处判断
  const scene = resolveRoomScene(
    room.backgroundKey,
    room.backgroundImage,
    room.backgroundFit,
  );

  io.to(code).emit("room:state", {
    code,
    name: room.name,
    phase: room.phase,
    startedAt: room.startedAt,
    hostId: room.hostId,
    backgroundKey: scene.key,
    backgroundImage: scene.image,
    backgroundFit: scene.fit,
    sceneCaption: room.sceneCaption,
    members: rows.map((row) =>
      toMemberView(row, onlineUserIds, characterByUser.get(row.userId) ?? null),
    ),
    serverTime: Date.now(),
  });

  // 位置单独发一条。挪棋子是高频小动作，跟着 room:state 一起走
  // 就等于每次都重查一遍数据库来拼完整的成员列表，纯属浪费
  io.to(code).emit("token:positions", { code, positions });

  /**
   * 本局结束时把还没掷的请求收掉。
   *
   * 放在 broadcastRoomState 里而不是某个 handler 里，是因为「阶段变了」
   * 有好几条来路（Server Action 的 refresh 通知、join、重开），
   * 每条都记得清一遍是不可能的。而这里本来就每次阶段变化都会跑。
   *
   * clearPendingRoll 返回 false 表示本来就没有，此时不发广播 ——
   * 否则每个加入已结束房间的人都会收到一条多余的 roll:pending。
   */
  if (room.phase === "ended") {
    clearPendingRoll(code);
  }
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

      /**
       * 历史消息补一份给这一个连接（不是广播）。
       *
       * 页面刷新时服务端渲染已经给过一份，但 Socket 重连（切网络、
       * 电脑休眠唤醒、断线自动重连）时页面不会重新加载 ——
       * 中间断掉的那几句只有靠这条补回来。
       * 发给自己而不是 io.to(room)：否则每有一个人刷新页面，
       * 全房间就跟着重复收到一遍历史。
       */
      socket.emit("chat:history", {
        code: normalized,
        messages: await listRecentMessages(room.id),
      });

      /**
       * 当前待掷的检定也补一份给这个连接。
       *
       * 没有这一条的话，刷新页面就会丢掉「等 xin 掷 d20」的提示 ——
       * 而那个请求在服务端还活着，于是 DM 那边还在等，xin 那边却没按钮了。
       * 只发给这一个连接，理由和 chat:history 一样。
       */
      socket.emit("roll:pending", {
        code: normalized,
        pending: peekPendingRoll(normalized),
      });

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
   * 把自己在舞台上的棋子挪到新位置。
   *
   * 只允许挪自己那一颗：不需要额外校验，因为这里根本不接受 userId ——
   * 位置永远记在 socket.data.user.id 名下。想动别人的棋子，
   * 唯一的办法是伪造连接，而连接在握手时就已经绑死了 session。
   */
  socket.on("token:move", ({ code, x, y } = { code: "", x: 0, y: 0 }) => {
    const normalized = normalizeRoomCode(String(code ?? ""));
    if (!normalized) return;

    // 必须真的订阅过这个房间，否则等于凭空往别人的舞台上塞东西
    if (!socket.data.joinedRooms.includes(normalized)) return;

    const map = roomPositions.get(normalized);
    if (!map) return;

    map.set(user.id, {
      // 留出边缘余量，否则棋子会被裁掉一半，或者压在场景描述上
      x: clampPercent(Number(x), 5, 95),
      y: clampPercent(Number(y), 24, 90),
    });

    const positions: TokenPosition[] = [...map.entries()].map(
      ([userId, point]) => ({ userId, x: point.x, y: point.y }),
    );

    io.to(normalized).emit("token:positions", { code: normalized, positions });
  });

  /**
   * 聊天节流：3 秒内最多 6 条。
   *
   * 不是防攻击，是防「按住回车不撒手」和「粘贴一大段分 N 条发」。
   * 这个频率对正常说话完全够用（正常人打字到不了 2 条/秒），
   * 但能把刷屏压到不毁掉别人阅读体验的程度。
   *
   * 数组存在 connection 作用域里，不是房间级 —— 所以一个人刷屏
   * 不会连累别人，断线重连后自动清零，不需要任何清理逻辑。
   */
  const recentChats: number[] = [];

  function chattingTooFast(): boolean {
    const now = Date.now();

    // 滑出时间窗。用 while 而不是 filter，避免每发一句就分配一个新数组
    while (recentChats.length > 0 && now - recentChats[0] > 3000) {
      recentChats.shift();
    }

    if (recentChats.length >= 6) return true;

    recentChats.push(now);
    return false;
  }

  /**
   * 发一条消息。
   *
   * 校验顺序是有讲究的，每一步挡的东西不一样：
   * 1. joinedRooms —— 挡「没订阅这个房间却在往里写」，和 token:move 同一道门
   * 2. ended 阶段 —— 挡「本局已结束还在记录里灌新内容」
   * 3. 正文校验 —— 挡空消息和超长消息
   * 4. 成员校验 —— 挡「被踢了但连接还没断」的那个瞬间
   *
   * 任何一步失败都要通过 ack 回传原因。少了 ack，前端就只能
   * 把输入框清空、然后什么都不发生 —— 玩家会以为是自己网络卡了。
   */
  socket.on("chat:send", async ({ code, body } = { code: "", body: "" }, ack) => {
    try {
      const normalized = normalizeRoomCode(String(code ?? ""));

      if (!socket.data.joinedRooms.includes(normalized)) {
        ack?.({ ok: false, error: "你不在这个房间里" });
        return;
      }

      const room = await getRoomByCode(normalized);
      if (!room) {
        ack?.({ ok: false, error: "房间不存在" });
        return;
      }

      // ended 是只读阶段：聊天记录留着看，但不再写新内容。
      // 和阶段权限保持一致 —— 既然属性、场景都锁了，聊天也不该例外
      if (room.phase === "ended") {
        ack?.({ ok: false, error: "本局已结束，不能再发言" });
        return;
      }

      const text = sanitizeChatBody(body);
      if (!text) {
        ack?.({ ok: false, error: "说点什么吧" });
        return;
      }

      if (chattingTooFast()) {
        ack?.({ ok: false, error: "说得太快了，缓一下再发" });
        return;
      }

      const rows = await listRoomMembers(room.id);
      const self = rows.find((item) => item.userId === user.id);
      if (!self) {
        ack?.({ ok: false, error: "你不在这个房间里" });
        return;
      }

      /**
       * 名字和头像框从「这个房间里的角色卡」取，而不是从用户资料取。
       * 跑团时大家认的是角色（「那个半精灵游侠」），不是注册昵称。
       * 没建卡的 DM 会退到昵称，正好也是他该显示的名字。
       */
      const summaries = await listRoomCharacterSummaries(room.id);
      const character = summaries.get(user.id) ?? null;

      const saved = await appendChatMessage({
        roomId: room.id,
        userId: user.id,
        body: text,
      });

      /**
       * 广播给房间里的所有人，包括发送者。
       *
       * 不做「发送者本地先插一条」的乐观更新：消息 id 和时间戳都在服务端生成，
       * 本地插一条再被广播覆盖会造成一次闪烁；而这个房间最多十来个人，
       * 一条 emit 的往返在一屏之内根本感知不到。
       */
      io.to(normalized).emit("chat:message", {
        code: normalized,
        message: {
          id: saved.id,
          userId: user.id,
          name: character?.name?.trim() || user.displayName,
          role: self.role,
          frame: character?.portrait.frame ?? null,
          body: text,
          createdAt: saved.createdAt,
        },
      });

      ack?.({ ok: true });
    } catch (error) {
      console.error("[socket] chat:send 失败", error);
      ack?.({ ok: false, error: "消息没发出去，重试一下" });
    }
  });

  /**
   * DM 要求某人做一次检定。
   *
   * 校验顺序和 chat:send 同一套思路：先证明「你确实在这个房间的实时频道里」，
   * 再证明「你有权这么做」，最后才处理内容。
   *
   * 注意这里**不接受加值**。客户端只说他希望谁、掷什么、难度多少，
   * 加值由服务端从目标的角色卡现算。这是整个功能唯一的防作弊落点 ——
   * 一旦加值来自请求体，改一个数字就能每次都 +30，而没有任何痕迹。
   */
  socket.on(
    "roll:request",
    async (
      {
        code = "",
        targetUserId = "",
        checkKey = "",
        faces,
        mode,
        count,
        dc = null,
        note = "",
      } = { code: "", targetUserId: "", checkKey: "", dc: null },
      ack,
    ) => {
      try {
        const normalized = normalizeRoomCode(String(code ?? ""));

        if (!socket.data.joinedRooms.includes(normalized)) {
          ack?.({ ok: false, error: "你不在这个房间里" });
          return;
        }

        const room = await getRoomByCode(normalized);
        if (!room) {
          ack?.({ ok: false, error: "房间不存在" });
          return;
        }

        if (room.phase !== "playing") {
          ack?.({
            ok: false,
            error:
              room.phase === "ended"
                ? "本局已结束，不能再掷骰"
                : "开局之后才能要求检定",
          });
          return;
        }

        const rows = await listRoomMembers(room.id);
        const self = rows.find((item) => item.userId === user.id);
        if (!self) {
          ack?.({ ok: false, error: "你不在这个房间里" });
          return;
        }

        if (self.role !== "dm") {
          ack?.({ ok: false, error: "只有 DM 能要求检定" });
          return;
        }

        const target = rows.find(
          (item) => item.userId === String(targetUserId),
        );
        if (!target) {
          ack?.({ ok: false, error: "这个人不在房间里" });
          return;
        }

        /**
         * 一个房间只允许一次待掷。
         *
         * 不覆盖上一个：DM 手滑点了两次的话，直接顶掉会让第一个目标
         * 的按钮凭空消失（他可能已经在准备了）。让他明确撤销更不容易出错。
         */
        if (peekPendingRoll(normalized)) {
          ack?.({
            ok: false,
            error: "还有一次检定没掷，先让他掷完或者撤销",
          });
          return;
        }

        const characterId = await getRoomCharacterId(room.id, target.userId);
        if (!characterId) {
          ack?.({ ok: false, error: "对方还没有角色卡，算不出加值" });
          return;
        }

        const character = await getCharacterById(characterId);
        if (!character) {
          ack?.({ ok: false, error: "找不到对方的角色卡" });
          return;
        }

        const check = resolveCheck(character, String(checkKey));
        if (!check) {
          ack?.({ ok: false, error: "不认识的检定项" });
          return;
        }

        // 骰型走白名单。检定默认 d20，留 faces/count 的口子是给以后的伤害骰
        const spec = sanitizeDiceSpec({ faces, mode, count });

        /**
         * DC 只允许 1~40。
         *
         * 5e 的难度从 5（很容易）到 30（几乎不可能），40 已经超出规则书，
         * 但给一点余量，免得房规党被卡住。不填就是不判成败 ——
         * 大量检定其实只是「掷一下看看」。
         */
        const safeDc =
          typeof dc === "number" && Number.isFinite(dc)
            ? Math.min(40, Math.max(1, Math.round(dc)))
            : null;

        const summaries = await listRoomCharacterSummaries(room.id);

        const view: RollPendingView = {
          id: randomUUID(),
          targetUserId: target.userId,
          targetName: summaries.get(target.userId)?.name?.trim() || "这位玩家",
          requestedBy: user.id,
          requestedByName: summaries.get(user.id)?.name?.trim() || user.displayName,
          label: check.label,
          note: String(note ?? "").trim().slice(0, 60),
          checkKey: String(checkKey),
          modifier: check.modifier,
          modifierParts: check.parts,
          dice: spec,
          dc: safeDc,
          createdAt: Date.now(),
        };

        pendingRolls.set(normalized, { view, roomId: room.id, spec });

        io.to(normalized).emit("roll:pending", {
          code: normalized,
          pending: view,
        });

        /**
         * 同一条事件也进聊天记录。
         *
         * 「谁要求、要求谁、什么检定、多难」是桌上所有人都该知道的，
         * 而舞台上方那条提示是**易失的**（掷完就消失、过期就消失）。
         * 聊天里的这一条是它的存档：翻回去还能看到这次判定的来由。
         */
        await postSystemChat({
          code: normalized,
          roomId: room.id,
          userId: user.id,
          kind: "roll-request",
          body: rollRequestText(view),
          payload: view,
        });

        ack?.({ ok: true });
      } catch (error) {
        console.error("[socket] roll:request 失败", error);
        ack?.({ ok: false, error: "发起检定失败了，重试一下" });
      }
    },
  );

  /** DM 撤销还没掷的那次请求 */
  socket.on("roll:cancel", async ({ code } = { code: "" }, ack) => {
    try {
      const normalized = normalizeRoomCode(String(code ?? ""));

      if (!socket.data.joinedRooms.includes(normalized)) {
        ack?.({ ok: false, error: "你不在这个房间里" });
        return;
      }

      const room = await getRoomByCode(normalized);
      if (!room) {
        ack?.({ ok: false, error: "房间不存在" });
        return;
      }

      const rows = await listRoomMembers(room.id);
      const self = rows.find((item) => item.userId === user.id);
      if (!self || self.role !== "dm") {
        ack?.({ ok: false, error: "只有 DM 能撤销检定" });
        return;
      }

      if (!clearPendingRoll(normalized)) {
        ack?.({ ok: false, error: "现在没有待掷的检定" });
        return;
      }

      ack?.({ ok: true });
    } catch (error) {
      console.error("[socket] roll:cancel 失败", error);
      ack?.({ ok: false, error: "撤销失败了" });
    }
  });

  /**
   * 被指定的人掷骰。
   *
   * 这个 handler 里有两件必须做对的事：
   *
   * 1. **原子摘除。** 先从待掷表里 delete，delete 返回 false 就说明
   *    这个请求已经被结算过（双击、两个标签页、或者别人抢先）。
   *    如果先检查后删除，中间隔着两个 await，两个请求都能通过检查。
   * 2. **先落库再广播。** 顺序反过来会出现「玩家看到 nat 20 欢呼，
   *    而库里没有这条记录」—— 那种不一致没法解释，也没法补救。
   *    宁可落库失败时让他重掷一次。
   */
  socket.on("roll:execute", async ({ code } = { code: "" }, ack) => {
    const normalized = normalizeRoomCode(String(code ?? ""));

    try {
      if (!socket.data.joinedRooms.includes(normalized)) {
        ack?.({ ok: false, error: "你不在这个房间里" });
        return;
      }

      const entry = pendingRolls.get(normalized);
      if (!entry) {
        ack?.({ ok: false, error: "现在没有待掷的检定" });
        return;
      }

      if (isPendingExpired(entry.view)) {
        pendingRolls.delete(normalized);
        io.to(normalized).emit("roll:pending", {
          code: normalized,
          pending: null,
        });
        ack?.({ ok: false, error: "这次检定过期了，让 DM 重新发起" });
        return;
      }

      if (entry.view.targetUserId !== user.id) {
        ack?.({ ok: false, error: "这次检定不是叫你掷" });
        return;
      }

      // 摘不到就说明已经被结算过了。这一步是幂等的关键
      if (!pendingRolls.delete(normalized)) {
        ack?.({ ok: false, error: "这次检定已经掷过了" });
        return;
      }

      const room = await getRoomByCode(normalized);
      if (!room) {
        ack?.({ ok: false, error: "房间不存在" });
        return;
      }

      const raw = rollRaw(entry.spec);
      const pickedIndex = pickIndex(raw, entry.spec.mode);
      const pickedValue = raw[pickedIndex] ?? 0;
      const total = rollTotal(raw, entry.spec, entry.view.modifier);
      const outcome = judgeOutcome(total, entry.view.dc);

      const summaries = await listRoomCharacterSummaries(room.id);
      const actorCharacter = summaries.get(user.id) ?? null;
      const rows = await listRoomMembers(room.id);
      const selfRow = rows.find((item) => item.userId === user.id);

      const saved = await appendRoll({
        roomId: room.id,
        actorId: user.id,
        requestedBy: entry.view.requestedBy,
        label: entry.view.label,
        checkKey: entry.view.checkKey,
        spec: entry.spec,
        raw,
        pickedIndex,
        pickedValue,
        modifier: entry.view.modifier,
        parts: entry.view.modifierParts,
        total,
        dc: entry.view.dc,
        outcome,
      });

      const result: RollResultView = {
        id: saved.id,
        actorId: user.id,
        actorName: actorCharacter?.name?.trim() || user.displayName,
        actorRole: selfRow?.role ?? "player",
        actorFrame: actorCharacter?.portrait.frame ?? null,

        label: entry.view.label,
        note: entry.view.note,
        checkKey: entry.view.checkKey,
        dice: entry.spec,
        raw,
        picked: pickedIndex,
        pickedValue,

        modifier: entry.view.modifier,
        modifierParts: entry.view.modifierParts,
        total,

        dc: entry.view.dc,
        outcome,

        natTwenty: isNatTwenty(pickedValue, entry.spec.faces),
        natOne: isNatOne(pickedValue, entry.spec.faces),
        createdAt: saved.createdAt,
      };

      // 先收掉「等某人掷」的提示，再发结果。
      // 反过来的话，浮层弹出时按钮还在，看起来能再点一次
      io.to(normalized).emit("roll:pending", {
        code: normalized,
        pending: null,
      });
      io.to(normalized).emit("roll:result", { code: normalized, result });

      /**
       * 结果也进聊天时间线。
       *
       * 这是「掷骰」和「说过的话」终于落在同一条线上的地方：
       * 玩家回头翻记录时，不会看到「DM 要求你过察觉」后面直接
       * 接着别人的闲聊，而中间那次大成功不见了。
       *
       * 放在 roll:result 之后：浮层的动画已经先出去了，
       * 聊天记录晚几十毫秒到没人注意得到，但顺序错了（记录先出现、
       * 浮层后弹）会让人多看一遍同样的数字。
       */
      await postSystemChat({
        code: normalized,
        roomId: room.id,
        userId: user.id,
        kind: "roll-result",
        body: rollResultText(result),
        payload: result,
      });

      ack?.({ ok: true });
    } catch (error) {
      console.error("[socket] roll:execute 失败", error);
      /**
       * 出错时也要把待掷状态清掉。
       *
       * 因为 pending 在进到这里之前就已经删了 —— 这时候如果只 ack 一个错误，
       * 服务端已经没有这条请求、客户端却还挂着按钮，玩家会一直点，
       * 每次都被告知「已经掷过了」。广播一个 null 让两边回到同一个状态。
       */
      io.to(normalized).emit("roll:pending", { code: normalized, pending: null });
      ack?.({ ok: false, error: "掷骰没成功，让 DM 重新发起" });
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

/**
 * 内部接口：让 Socket 进程重播一次房间状态。
 *
 * 角色卡在 Next 进程里保存，房间里其他人却连在 Socket 进程上。
 * 和踢人一样，两个进程之间没有共享内存，只能通知一次。
 *
 * 但这里不需要逐个 socket 操作：角色卡摘要是随 room:state 一起下发的，
 * 重播一次广播，所有人的界面就都拿到新数据了。
 */
async function handleInternalRefresh(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers[INTERNAL_TOKEN_HEADER] !== INTERNAL_TOKEN) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }

  const body = (await readJsonBody(req)) as { code?: unknown } | null;
  const code = normalizeRoomCode(String(body?.code ?? ""));

  if (!code) {
    sendJson(res, 400, { ok: false, error: "code 必须传" });
    return;
  }

  await broadcastRoomState(code);
  sendJson(res, 200, { ok: true });
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

  if (url === "/internal/refresh" && req.method === "POST") {
    void handleInternalRefresh(req, res).catch((error) => {
      console.error("[socket] 内部刷新失败", error);
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
