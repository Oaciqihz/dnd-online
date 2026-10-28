import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * 游客和注册用户共用一张表：
 * - kind = "guest"      -> 没有 username / passwordHash
 * - kind = "member"     -> 有 username / passwordHash
 * 这样后面做“游客升级成正式账号”只需要补字段，不用迁移数据。
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["guest", "member"] })
    .notNull()
    .default("guest"),
  username: text("username").unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  createdAt: integer("created_at").notNull(),
});

/**
 * 会话表。数据库里只存 token 的 SHA-256，不存明文。
 * 这样即使数据库泄露，攻击者也无法直接拿里面的值伪造登录。
 */
export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/**
 * 房间所处的阶段。
 *
 * 这个字段的全部价值在于「它约束了什么」，而不是它叫什么名字。
 * 一个没有任何地方读取的状态字段，等同于不存在。
 *
 * - preparing：建卡、试掷、等人。角色卡可自由编辑和更换
 * - playing：属性锁定（HP 和备注仍然可改，战斗中扣血是刚需），掷骰写入日志
 * - ended：整间房只读
 *
 * 「开始游戏」的实质不是宣布游戏开始，而是收紧权限。
 * 类型定义在 protocol.ts，因为前后端都要用到它。
 */

/**
 * 房间。code 是给玩家口头传播用的短码（6 位，去掉了易混淆字符），
 * 唯一约束保证不会撞车。
 */
export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    phase: text("phase", { enum: ["preparing", "playing", "ended"] })
      .notNull()
      .default("preparing"),
    /**
     * 最近一次进入 playing 的时刻。DM 退回准备再重新开始时会被刷新，
     * 用来在横幅上显示「本局已进行 42 分钟」。
     */
    startedAt: integer("started_at"),

    /**
     * 舞台背景（内置场景）。存的是渐变的 key，不是图片地址。
     *
     * 有了 DM 上传之后这个字段仍然保留，作用从「就是背景」变成
     * 「背景图之下/之外的底色」—— 图加载中、图挂掉、contain 留白时兜底。
     * 所以它永远有值，永远不会让舞台出现一块纯黑。
     */
    backgroundKey: text("background_key").notNull().default("tavern"),

    /**
     * DM 上传的地图。空字符串表示只用内置渐变。
     *
     * 和角色立绘取同一个白名单校验（lib/media/ref.ts）：
     * 要么是我们存储里的 key（本地 s_xxx.webp），要么是 https 绝对地址。
     * 存「能直接用的地址」而不是供应商 id，理由见 lib/media/storage.ts。
     */
    backgroundImage: text("background_image").notNull().default(""),

    /**
     * 背景图怎么填进 16:9 的舞台：cover 裁边填满 / contain 完整显示。
     *
     * 单独存一列而不是塞进 backgroundImage 的 JSON，是因为
     * 它是一个独立的选择（同一张图换两种填法都合理），
     * 而且以后可能加 blur、暗度这类同样独立的显示参数。
     */
    backgroundFit: text("background_fit").notNull().default("cover"),

    /**
     * 当前场景的一句话。DM 换背景时可以顺手写「你们推开沉重的木门」。
     *
     * 这句描述才是场景切换的真正价值 —— 单纯的换图只会在开局被用一次，
     * 而带描述的场景切换会变成跑团的叙事节奏。
     * 等 game_events 表建起来之后，每一次切换都会成为其中一条事件。
     */
    sceneCaption: text("scene_caption").notNull().default(""),

    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("rooms_host_idx").on(table.hostId)],
);

/**
 * 角色卡。
 *
 * 关键设计：卡属于「用户」，不属于「房间」。
 * 跑团是连续的、房间是临时的，如果卡跟着房间走，房间一散玩家的心血就没了。
 * 房间和卡的关系放在 room_members.character_id 里，只记「这一局用哪张卡」。
 *
 * 字段分两类：
 * - 会被计算、排序、查询的（等级、六属性、熟练项）拆成列
 * - 只给人看的（装备、法术、背景故事）都塞进 data 那种自由字段
 * 这样将来用户改房规、加自定义内容，不用改表结构。
 */
export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // 第一步：基础信息
    name: text("name").notNull(),
    /** 职业的英文 key，用来查生命骰；className 是展示用的中文名 */
    classKey: text("class_key").notNull().default("fighter"),
    className: text("class_name").notNull().default("战士"),
    level: integer("level").notNull().default(1),
    ancestry: text("ancestry").notNull().default(""),
    background: text("background").notNull().default(""),
    alignment: text("alignment").notNull().default(""),

    // 第二步：六属性
    str: integer("str").notNull().default(10),
    dex: integer("dex").notNull().default(10),
    con: integer("con").notNull().default(10),
    int: integer("int").notNull().default(10),
    wis: integer("wis").notNull().default(10),
    cha: integer("cha").notNull().default(10),

    // 第三步：熟练项。存 JSON 数组字符串，读取时统一走 parseJsonArray 兜底
    skills: text("skills").notNull().default("[]"),
    saves: text("saves").notNull().default("[]"),

    // 生命与防御：currentHp 会变所以必须存；maxHp / ac 由公式算，不存
    currentHp: integer("current_hp").notNull().default(0),
    tempHp: integer("temp_hp").notNull().default(0),
    /** 专长、种族特性带来的额外生命值，默认 0 */
    hpBonus: integer("hp_bonus").notNull().default(0),
    /** 玩家手动填的 AC（穿甲、持盾）。null 表示用 10 + 敏捷调整 计算 */
    acOverride: integer("ac_override"),

    // 第四、五步：自由文本，不参与任何计算
    equipment: text("equipment").notNull().default(""),
    spells: text("spells").notNull().default(""),
    features: text("features").notNull().default(""),
    backstory: text("backstory").notNull().default(""),
    notes: text("notes").notNull().default(""),

    /**
     * 舞台上的形象。存 JSON，形状见 lib/portrait.ts 的 Portrait。
     *
     * 里面可能是「我们自己的图片 key」「云图床的完整地址」或者
     * 「生成式头像的风格 + 种子」，三种都表达同一件事：这个角色长什么样。
     *
     * 上一版这里是五轴枚举的分层拼装（旧列 look），已经废弃。
     * 旧列不删是因为 SQLite 删列要重建表，风险远大于收益，
     * 而它带着 DEFAULT '{}'，无人读写也不占空间。
     */
    portrait: text("portrait").notNull().default("{}"),

    /** draft = 建卡向导还没走完，ready = 可以带进房间 */
    status: text("status", { enum: ["draft", "ready"] })
      .notNull()
      .default("draft"),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("characters_owner_idx").on(table.ownerId)],
);

/**
 * 房间成员。用 (roomId, userId) 做联合主键，
 * 数据库层面就保证了同一个人不会在同一个房间里出现两次
 * —— 重复加入用 onConflictDoNothing 天然幂等。
 */
export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["dm", "player"] })
      .notNull()
      .default("player"),
    /**
     * 这一局用的是哪张角色卡。
     * 用 set null 而不是 cascade：删掉一张卡不应该把人也踢出房间。
     */
    characterId: text("character_id").references(() => characters.id, {
      onDelete: "set null",
    }),
    /**
     * 玩家自己按下的「我准备好了」。
     *
     * 这只是给 DM 看的一个信号，不参与任何权限判断 ——
     * 要不要开始由 DM 决定，不做「全员就绪自动开团」：
     * 总有人迟到、临时改卡，自动开始会让状态反复抖动。
     */
    ready: integer("ready", { mode: "boolean" }).notNull().default(false),
    joinedAt: integer("joined_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index("room_members_user_idx").on(table.userId),
  ],
);

/**
 * 房间聊天记录。
 *
 * 为什么不复用「游戏事件」那张表：两者长得像，但生命周期完全不同。
 * 事件（掷骰、场景切换、掉血）是一局游戏的骨架，需要能被过滤、回放、
 * 甚至被 DM 撤销；聊天是一局游戏里**人说的话**，量大、无结构、只用来读。
 * 混在一起之后，想「只看掷骰结果」就得给同一张表加越来越多条件，
 * 而两类数据的分页、清理策略本来就不一样。
 *
 * 不存 name / frame / color 快照，是有意的：这三样都是「角色当前长什么样」，
 * 玩家改一次角色名或换一个头像框，历史消息跟着变才是对的 ——
 * 跑团中途换框很常见，聊天记录还留着旧颜色反而像 bug。
 * 代价是这个人退房之后查不到他的框，此时退成默认色（见 lib/chat.ts）。
 */
export const roomMessages = sqliteTable(
  "room_messages",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /**
     * 用 CASCADE：用户注销后他发过的话跟着走。
     * 另一种选择是把 user_id 置 null 保留内容，但那会让「谁说的」永久丢失，
     * 而聊天记录的价值有一半在于说话的人，留一句无名氏的话没有意义。
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    /**
     * 这一条是聊天还是系统事件。
     *
     * 判定类型本身（chat / roll-request / roll-result）其实在 payload 里也有，
     * 但把它单独拎成一列，是为了**能按列过滤**：将来要「只看掷骰记录」
     * 或者统计「这局 DM 要求了几次检定」，就是一条 where，
     * 而不是把整个房间的消息全读出来再逐条 JSON.parse。
     */
    kind: text("kind").notNull().default("chat"),
    /**
     * 系统事件的结构化载荷（JSON）。聊天消息是空字符串。
     *
     * 为什么系统事件要存两份（body 一句话 + payload 一份结构）：
     * body 是给人看、给搜索用的；payload 是给卡片渲染用的。
     * 只有 body 的话，聊天栏里就只剩一行字，
     * 玩家看不到「d20 掷了 15 / 2、取 15、+5 = 20」这个推导过程 ——
     * 而跑团玩家是真的会逐颗核对的。
     */
    payload: text("payload").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // 查询永远是「这个房间最近的 N 条」，所以索引要带 created_at 一起
    index("room_messages_room_idx").on(table.roomId, table.createdAt),
  ],
);

/**
 * 掷骰结果。
 *
 * 和聊天分开存，理由和「事件 vs 聊天」一样：掷骰是**结构化的判定**，
 * 将来要做战报、要统计「这局掷了几次 nat 1」、要让 DM 撤销一次误掷，
 * 都需要按字段查。如果把它塞进 room_messages.body 里，
 * 这些查询全都变成字符串匹配。
 *
 * 存原始点数数组而不是只存 total，是这张表最重要的决定：
 * - 优势/劣势要能展示「另一颗是什么」，否则玩家无法验证你确实掷了两颗
 * - 天然 20 / 天然 1 要能识别，而这取决于**某一颗**的值
 * - 跑团玩家是真的会较真的，只给一个总数等于要求他相信你
 *
 * 不存 actor 的名字和头像框 —— 和 room_messages 同一个理由，
 * 查询时按当前的卡现场取，换框之后历史记录跟着变。
 */
export const roomRolls = sqliteTable(
  "room_rolls",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** 掷骰的人 */
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 要求他掷的人（DM）。和 actorId 分开，因为这两个常常不是同一个人 */
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** 展示用的名字，如「运动检定」。落库时定下来，之后改规则也不能让它变 */
    label: text("label").notNull().default(""),
    /**
     * 检定标识，如 `skill:athletics` / `save:dex`。
     * 加值不存原始公式而是存这个键，将来要复核「这一掷算得对不对」
     * 可以拿它重新跑一遍 resolveCheck
     */
    checkKey: text("check_key").notNull().default(""),

    /** DiceSpec 的 JSON：{count, faces, mode} */
    dice: text("dice").notNull(),
    /** 每颗骰子的原始点数，JSON 数字数组 */
    rawRolls: text("raw_rolls").notNull().default("[]"),
    /** 生效那颗在 rawRolls 里的下标。优势/劣势时用它高亮 */
    picked: integer("picked").notNull().default(0),
    /** 生效那颗的点数。存下来是为了不必在读取时再跑一次 pickRoll */
    pickedValue: integer("picked_value").notNull().default(0),

    modifier: integer("modifier").notNull().default(0),
    /** 加值的构成，JSON：[{label:'敏捷调整', value:3}, {label:'熟练', value:2}] */
    modifierParts: text("modifier_parts").notNull().default("[]"),

    total: integer("total").notNull(),
    /** DM 设的难度。null 表示他没设，那就只有点数没有成败 */
    dc: integer("dc"),
    /** success / fail / null（没设 DC 时） */
    outcome: text("outcome"),

    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    // 查询永远是「这个房间最近的 N 条」
    index("room_rolls_room_idx").on(table.roomId, table.createdAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type RoomMessageRow = typeof roomMessages.$inferSelect;
export type RoomRollRow = typeof roomRolls.$inferSelect;
