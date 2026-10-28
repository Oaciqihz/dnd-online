import type { SessionUser } from "./session-store";
import type { Portrait, PortraitFrame } from "./portrait";
import type { SceneFit, SceneKey } from "./scenes";
import type { DiceSpec } from "./dice";

/**
 * 前后端共用的消息协议。
 * 服务端（server/index.ts）和客户端（React 组件）都从这里取类型，
 * 改字段时两边会同时报错，不会悄悄对不上。
 *
 * 注意：这个文件只放「类型」，不 import 任何运行时模块，
 * 否则会把服务端代码带进浏览器的包里。
 */

export type RoomRole = "dm" | "player";

/**
 * 房间阶段。类型放在这里而不是 schema.ts，
 * 是因为 schema.ts 里 import 了 drizzle 的运行时模块，
 * 而浏览器端只需要这个字符串联合类型，不该被打进包里。
 */
export type RoomPhase = "preparing" | "playing" | "ended";

/**
 * 角色卡摘要 —— 房间里所有人都能看到的那些字段。
 *
 * 这个类型是「公开面」。完整卡（属性、装备、背景故事）的类型是
 * characters.ts 里的 CharacterDetail，只在服务端按「本人或 DM」判断后才会产出。
 * 两者刻意分开定义，因为一旦有人把 CharacterDetail 塞进广播，
 * 就等于把所有细节推给了房间里的每一个人。
 */
export type CharacterSummary = {
  id: string;
  ownerId: string;
  name: string;
  classKey: string;
  className: string;
  level: number;
  ancestry: string;
  currentHp: number;
  maxHp: number;
  tempHp: number;
  ac: number;
  status: "draft" | "ready";
  /**
   * 舞台上的形象。放摘要里是因为它就是「公开面」的一部分 ——
   * 房间里所有人本来就互相看得见对方长什么样。
   *
   * 里面可能是一个图片地址，也可能是生成头像的参数，两种都很短
   * （几十字节），随成员列表一起广播没有压力。
   */
  portrait: Portrait;
};

/** 舞台上一个棋子的位置，坐标是 0-100 的百分比，不依赖像素 */
export type TokenPosition = {
  userId: string;
  x: number;
  y: number;
};

/** 发给客户端的成员视角：在数据库字段基础上加了在线状态和当前角色卡 */
export type RoomMemberView = {
  userId: string;
  displayName: string;
  kind: "guest" | "member";
  role: RoomRole;
  online: boolean;
  /** 玩家自己按下的「我准备好了」。DM 恒为 false，因为他不参与就绪统计 */
  ready: boolean;
  character: CharacterSummary | null;
};

export type RoomAck = { ok: true } | { ok: false; error: string };

/**
 * 一条聊天消息的对外形状。
 *
 * 刻意**不带颜色**，只带推导颜色需要的两个事实：role 和 frame。
 *
 * 如果这里直接塞一个 color 字符串，它就变成了发送那一刻的快照 ——
 * 玩家换了头像框，新消息是新的颜色、老消息还是旧的，同一行里两种颜色，
 * 看起来就是 bug。带事实不带结论，渲染时统一调 lib/chat.ts 的 chatColor，
 * 才是「文字颜色跟随头像框」的正确含义。
 */
export type ChatMessageView = {
  id: string;
  userId: string;
  /** 角色名优先，没建卡时用昵称 */
  name: string;
  role: RoomRole;
  /** 说话人的头像框。null = 没有角色卡或已退房，此时用默认色 */
  frame: PortraitFrame | null;
  body: string;
  createdAt: number;

  /**
   * 这一条是什么。
   *
   * 缺省（或 "chat"）就是人说的话；另外两种是**系统事件**：
   * 发起检定、掷骰结算。它们和聊天挤在同一条时间线里，
   * 是因为跑团的信息本来就是交织的 ——「我要撬锁」→「过个巧手」
   * →「掷出 18」→「锁开了」，把掷骰单独放一个面板等于要求
   * 玩家自己在两个地方来回对照。
   *
   * 系统条目仍然写进 room_messages（而不是只在客户端合成）：
   * 刷新页面、断线重连之后，聊天记录里的检定过程要还在。
   * 只在内存里拼的后果是「一刷新，刚才那次大成功就从记录里消失了」。
   */
  kind?: ChatEntryKind;

  /** kind === "roll-result" 时的结构化结果，聊天栏据此渲染骰子卡片 */
  roll?: RollResultView | null;

  /** kind === "roll-request" 时的请求 */
  request?: RollPendingView | null;
};

export type ChatEntryKind = "chat" | "roll-request" | "roll-result";

/**
 * 一次「等待某人掷骰」的请求，发给房间里所有人。
 *
 * 为什么所有人都会收到、而不只是 DM 和被指定者：
 * 桌上其他玩家有权知道「现在轮到 xin 过运动检定」——
 * 这正是跑团里最自然的注意力聚焦方式。而按钮只在被指定者那里渲染。
 *
 * 带 modifier 是有意的：加值本来就是公开信息（角色卡上写着），
 * 而且摊开之后玩家能自己核对「d20 + 5 = 19」对不对。
 * 藏着它反而会让人怀疑数字来路不明。
 */
export type RollPendingView = {
  id: string;
  targetUserId: string;
  targetName: string;
  /** 发起人（DM） */
  requestedBy: string;
  requestedByName: string;
  /** 展示名，如「运动检定」 */
  label: string;
  /** DM 写的一句话，如「推开石门」。空字符串表示他没写 */
  note: string;
  /** 如 `skill:athletics`，想复核加值时用 */
  checkKey: string;
  modifier: number;
  modifierParts: Array<{ label: string; value: number }>;
  dice: DiceSpec;
  /** DM 设的难度。null = 只有点数，不判成败 */
  dc: number | null;
  createdAt: number;
};

/**
 * 一次已经结算的掷骰。
 *
 * 这个形状在广播里出现一次，同时落进 room_rolls —— 两者字段是对齐的，
 * 所以将来把历史记录读出来时不需要另一套转换。
 *
 * natTwenty / natOne 由服务端算好带下来，不让每个客户端各算一遍：
 * 「算大成功」这条规则将来要跟着房规变，改一个地方比改四处可靠。
 */
export type RollResultView = {
  id: string;
  actorId: string;
  /** 角色名优先，没建卡时用昵称 */
  actorName: string;
  /** 掷骰的人是 DM 还是玩家，决定数字用金色还是他自己的框色 */
  actorRole: RoomRole;
  actorFrame: PortraitFrame | null;

  label: string;
  note: string;
  checkKey: string;
  dice: DiceSpec;

  /** 每颗骰子的原始点数。优势/劣势时会有两颗，玩家据此验证你确实掷了两次 */
  raw: number[];
  /** 生效那颗在 raw 里的下标 */
  picked: number;
  pickedValue: number;

  modifier: number;
  modifierParts: Array<{ label: string; value: number }>;
  total: number;

  dc: number | null;
  outcome: "success" | "fail" | null;

  natTwenty: boolean;
  natOne: boolean;
  createdAt: number;
};

export type ServerToClientEvents = {
  "session:ready": (payload: {
    user: SessionUser;
    serverTime: number;
  }) => void;

  /** 房间成员、在线状态或阶段变化时，广播给房间里所有人 */
  "room:state": (payload: {
    code: string;
    name: string;
    phase: RoomPhase;
    /** 最近一次进入「进行中」的时刻，横幅上用来显示已进行时长 */
    startedAt: number | null;
    /** 房主 id。客户端据此判断当前用户是不是 DM，不用额外接口 */
    hostId: string;
    /** 舞台背景（内置渐变）的 key。背景图存在时它是兜底底色 */
    backgroundKey: SceneKey;
    /**
     * DM 上传的地图。空字符串表示只用内置渐变。
     *
     * 和人物立绘一样，这是一个「已通过白名单的图片标识」，
     * 客户端拿到后自己拼成 /media/xxx 或直接用 https 地址。
     * 之所以不在这里就转成完整 URL：这条广播同时被服务端渲染和
     * 浏览器渲染消费，两边的拼接规则必须一致，而一致的办法是只有一份规则。
     */
    backgroundImage: string;
    /** 背景图填进 16:9 舞台的方式：cover 裁边填满 / contain 完整显示 */
    backgroundFit: SceneFit;
    /** 当前场景的一句话，DM 换背景时写 */
    sceneCaption: string;
    members: RoomMemberView[];
    serverTime: number;
  }) => void;

  /**
   * 所有棋子的位置。
   *
   * 独立于 room:state 单独发，因为它是高频、轻量的消息：
   * 每次有人挪棋子都重查一遍数据库来拼完整的成员列表，纯属浪费。
   */
  "token:positions": (payload: {
    code: string;
    positions: TokenPosition[];
  }) => void;

  /**
   * 被 DM 移出房间。
   * 服务端发完这条就把连接从房间频道里摘掉，所以客户端必须自己离开页面，
   * 否则会停在一个「已经看不到任何更新」的房间里。
   */
  "room:kicked": (payload: { code: string; reason: string }) => void;

  /**
   * 一屏历史消息。每次 room:join 成功之后补发一次。
   *
   * 服务端渲染时也会把同样的历史塞进首屏，两条路径都要，
   * 因为它们的失效场景不一样：SSR 覆盖「第一次打开页面」，
   * 这条广播覆盖「页面没刷新但 Socket 重连了」。
   * 只做其中一条，另一种情况就会看到空白聊天框。
   */
  "chat:history": (payload: {
    code: string;
    messages: ChatMessageView[];
  }) => void;

  /** 新消息。房间里所有人（包括发送者自己）都会收到这一条 */
  "chat:message": (payload: { code: string; message: ChatMessageView }) => void;

  /**
   * 当前「等谁掷骰」的状态。null 表示没有待掷的请求。
   *
   * 发起、撤销、超时失效三种情况都走这一条广播。
   * 用一个可空的状态字段而不是 request + cancel 两条事件：
   * 客户端只认一个状态源，就不会出现「界面还显示等 xin 掷骰，
   * 但服务端那边早就没了」这种对不上的情况。
   */
  "roll:pending": (payload: {
    code: string;
    pending: RollPendingView | null;
  }) => void;

  /**
   * 掷骰结算。
   *
   * 房间里所有人收到的是**同一份结果**，各自从收到那一刻起播动画。
   * 不做动画时钟同步：50~200ms 的差异没人看得出来，
   * 而为此在协议里塞时间戳、再对一遍时钟，是纯粹的复杂度。
   */
  "roll:result": (payload: { code: string; result: RollResultView }) => void;
};

export type ClientToServerEvents = {
  "ping:check": (ack?: (payload: { pong: number }) => void) => void;

  /** 订阅房间的实时通道（只允许已经是房间成员的人） */
  "room:join": (
    payload: { code: string },
    ack?: (result: RoomAck) => void,
  ) => void;

  "room:leave": (
    payload: { code: string },
    ack?: (result: RoomAck) => void,
  ) => void;

  /**
   * 把自己在舞台上的棋子挪到新位置。
   *
   * 第一版只允许挪自己那一颗。DM 移动别人的棋子（比如拖 NPC）留到后面 ——
   * 那需要先有 NPC 这个概念，而现在房间里只有玩家。
   */
  "token:move": (payload: { code: string; x: number; y: number }) => void;

  /**
   * 发一条聊天消息。
   *
   * 走 Socket 而不是 Server Action：聊天是唯一的「双向高频」动作，
   * 一次 Server Action 往返要经历路由匹配 + RSC payload 序列化 + 页面重渲染，
   * 几百毫秒的延迟在一句接一句的对话里非常明显。
   * 而 Socket 连接本来就在，一条 emit 出去，服务端广播回来是同一个 tick。
   *
   * ack 用来告诉发送方「发出去了」或「被拒了」——
   * 被拒的原因（不在房间、房间已结束、发太快）必须回传，
   * 否则前端只能把输入框清空然后什么都不发生。
   */
  "chat:send": (
    payload: { code: string; body: string },
    ack?: (result: RoomAck) => void,
  ) => void;

  /**
   * DM 要求某个人做一次检定。
   *
   * 只传「谁、什么检定、难度多少」，**不传加值**——
   * 加值由服务端从目标角色卡现算（见 characters.ts 的 resolveCheck）。
   * 让客户端传加值等于把判定权交了出钱，改一个数字就能每次都 +30。
   *
   * 也不传骰子点数。骰子规格只允许在这条里指定 faces / count / mode，
   * 而结果永远由服务端生成。
   */
  "roll:request": (
    payload: {
      code: string;
      targetUserId: string;
      checkKey: string;
      /** 骰型，缺省 d20 */
      faces?: number;
      mode?: string;
      count?: number;
      dc: number | null;
      /** 一句话说明，DM 写「推开石门」这种 */
      note?: string;
    },
    ack?: (result: RoomAck) => void,
  ) => void;

  /** DM 撤销还没掷的那次请求 */
  "roll:cancel": (
    payload: { code: string },
    ack?: (result: RoomAck) => void,
  ) => void;

  /**
   * 被指定的人按下「掷骰」。
   *
   * 这个动作里没有任何随机性 —— 它只是说「我准备好了」，
   * 点数由服务端在这一步生成。所以：
   * - 只有 pendingRoll.targetUserId 本人能调，别人调会被拒
   * - 服务端结算时先从待掷表里摘掉，摘不到就说明已经掷过了
   *   （双击、两个标签页同时点，都靠这一条挡住）
   */
  "roll:execute": (
    payload: { code: string },
    ack?: (result: RoomAck) => void,
  ) => void;
};

export type SocketData = {
  user: SessionUser;
  /** 这个连接当前订阅了哪些房间，断线时要据此广播离线 */
  joinedRooms: string[];
  /** 握手成功的时刻，排查连接泄漏时用来看每条连接活了多久 */
  connectedAt: number;
};
