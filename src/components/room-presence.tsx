"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  kickMemberAction,
  setRoomPhaseAction,
  toggleReadyAction,
} from "@/app/actions/rooms";
import {
  adjustHpAction,
  setRoomCharacterAction,
} from "@/app/actions/characters";
import { releaseSocket, retainSocket } from "@/lib/socket-client";
import { CHAT_HISTORY_LIMIT } from "@/lib/chat";
import { PHASE_LABEL, phaseCapabilities, phaseHint } from "@/lib/permissions";
import type {
  CharacterSummary,
  ChatMessageView,
  RollPendingView,
  RollResultView,
  RoomMemberView,
  RoomPhase,
  TokenPosition,
} from "@/lib/protocol";
import { DEFAULT_PORTRAIT } from "@/lib/portrait";
import type { RollMode } from "@/lib/dice";
import { CharacterToken } from "./character-token";
import { ChatPanel } from "./chat-panel";
import { DiceRollOverlay } from "./dice-roll-overlay";
import { RollPendingBar, RollRequestPanel } from "./roll-request-panel";
import { StageView } from "./stage-view";

type Props = {
  code: string;
  selfId: string;
  initialMembers: RoomMemberView[];
  initialPhase: RoomPhase;
  initialStartedAt: number | null;
  initialBackgroundKey: string;
  initialBackgroundImage: string;
  initialBackgroundFit: "cover" | "contain";
  initialSceneCaption: string;
  hostId: string;
  /** 自己卡库里可以带入房间的卡，用来在成员行里直接切换 */
  myCharacters: CharacterSummary[];
  /**
   * 首屏聊天记录。
   *
   * 由服务端渲染时查好塞进来，而不是等 Socket 连上再拉：
   * 否则打开房间的第一秒永远是空聊天框，然后内容"啪"地跳出来，
   * 看起来像是刚有人发了消息。
   */
  initialMessages: ChatMessageView[];
};

type ConnState = "connecting" | "online" | "offline";

const STATUS_LABEL: Record<ConnState, string> = {
  connecting: "连接中…",
  online: "实时同步中",
  offline: "连接已断开",
};

const STATUS_DOT: Record<ConnState, string> = {
  connecting: "bg-stone-500",
  online: "bg-emerald-500",
  offline: "bg-red-500",
};

/**
 * 阶段横幅的配色。
 * 准备用琥珀、进行中用青绿、结束用灰 —— 靠颜色区分，
 * 玩家扫一眼就知道现在能不能改卡。
 */
const PHASE_STYLE: Record<
  RoomPhase,
  { border: string; bg: string; dot: string; text: string }
> = {
  preparing: {
    border: "border-amber-800/50",
    bg: "bg-amber-950/20",
    dot: "bg-amber-500",
    text: "text-amber-300",
  },
  playing: {
    border: "border-emerald-800/50",
    bg: "bg-emerald-950/20",
    dot: "bg-emerald-500",
    text: "text-emerald-300",
  },
  ended: {
    border: "border-ink-700",
    bg: "bg-ink-900/40",
    dot: "bg-stone-500",
    text: "text-stone-400",
  },
};

function formatElapsed(startedAt: number, now: number): string {
  const minutes = Math.floor((now - startedAt) / 60_000);
  if (minutes < 1) return "刚开始";
  if (minutes < 60) return `已进行 ${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `已进行 ${hours} 小时`
    : `已进行 ${hours} 小时 ${rest} 分钟`;
}

export function RoomPresence({
  code,
  selfId,
  initialMembers,
  initialPhase,
  initialStartedAt,
  initialBackgroundKey,
  initialBackgroundImage,
  initialBackgroundFit,
  initialSceneCaption,
  hostId,
  myCharacters,
  initialMessages,
}: Props) {
  const [members, setMembers] = useState<RoomMemberView[]>(initialMembers);
  const [phase, setPhase] = useState<RoomPhase>(initialPhase);
  const [startedAt, setStartedAt] = useState<number | null>(initialStartedAt);
  const [backgroundKey, setBackgroundKey] = useState(initialBackgroundKey);
  const [backgroundImage, setBackgroundImage] = useState(initialBackgroundImage);
  const [backgroundFit, setBackgroundFit] = useState<"cover" | "contain">(
    initialBackgroundFit,
  );
  const [sceneCaption, setSceneCaption] = useState(initialSceneCaption);
  const [positions, setPositions] = useState<TokenPosition[]>([]);
  const [messages, setMessages] = useState<ChatMessageView[]>(initialMessages);
  const [scenePanelOpen, setScenePanelOpen] = useState(false);

  /**
   * 掷骰相关的三个状态。
   *
   * pendingRoll 是「服务端认为现在等谁掷」，由广播驱动，本地从不猜 ——
   * 它涉及跨用户的协调，本地乐观更新只会制造两个人都以为自己该掷的局面。
   *
   * rollResult 只用来驱动浮层，不参与任何判断，所以播完就清掉。
   */
  const [pendingRoll, setPendingRoll] = useState<RollPendingView | null>(null);
  const [rollResult, setRollResult] = useState<RollResultView | null>(null);
  const [rollBusy, setRollBusy] = useState(false);
  const [rollError, setRollError] = useState<string | null>(null);

  const [conn, setConn] = useState<ConnState>("connecting");
  const [kicked, setKicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * 计时基准。刻意从 null 开始，在 effect 里才取 Date.now() ——
   * 服务端渲染时算一次、客户端水合时再算一次，两个时间不同，
   * 直接渲染「已进行 N 分钟」会触发 hydration 不匹配警告。
   */
  const [now, setNow] = useState<number | null>(null);

  /** 第一次点击只是「上膛」，再点一次才真的踢出去 / 结束本局，避免误触 */
  const [armingId, setArmingId] = useState<string | null>(null);
  const [armingEnd, setArmingEnd] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 拖动棋子要用到连接，但连接是在 effect 里建的，所以存一份引用 */
  const socketRef = useRef<ReturnType<typeof retainSocket> | null>(null);

  const selfMember = members.find((item) => item.userId === selfId);
  const selfRole = selfMember?.role ?? null;

  /**
   * 把消息里的 frame 换成「这个人现在的 frame」。
   *
   * 消息对象里的 frame 是发送那一刻的快照，只靠它的话，
   * 有人换了头像框，他自己屏幕上是新颜色、别人屏幕上还是旧的 ——
   * 而且旧消息永远是旧色，因为已经收到的对象不会自己更新。
   *
   * 这里用当前成员列表覆盖一次，颜色就真的「跟随」了：
   * 房间状态一变（换框会触发 portrait 更新 → 房间刷新 → room:state），
   * 所有人的聊天配色一起变。
   *
   * 已经退房的人不在 members 里，保留消息里带着的 frame，
   * 不至于让他那几行字突然变成默认色。
   */
  const chatMessages = useMemo(() => {
    const frameByUser = new Map(
      members.map((item) => [
        item.userId,
        item.character?.portrait.frame ?? null,
      ]),
    );

    return messages.map((message) =>
      frameByUser.has(message.userId)
        ? { ...message, frame: frameByUser.get(message.userId) ?? null }
        : message,
    );
  }, [messages, members]);

  const caps = phaseCapabilities({
    phase,
    hostId,
    viewerId: selfId,
    viewerRole: selfRole,
  });

  useEffect(() => {
    const socket = retainSocket();
    socketRef.current = socket;

    const subscribe = () => {
      socket.emit("room:join", { code });
    };

    const onConnect = () => {
      setConn("online");
      subscribe();
    };
    const onDisconnect = () => setConn("offline");
    const onError = () => setConn("offline");

    const onState = (payload: {
      code: string;
      phase: RoomPhase;
      startedAt: number | null;
      backgroundKey: string;
      backgroundImage: string;
      backgroundFit: "cover" | "contain";
      sceneCaption: string;
      members: RoomMemberView[];
      serverTime: number;
    }) => {
      if (payload.code !== code) return;
      setMembers(payload.members);
      setPhase(payload.phase);
      setStartedAt(payload.startedAt);
      setBackgroundKey(payload.backgroundKey);
      setBackgroundImage(payload.backgroundImage);
      setBackgroundFit(payload.backgroundFit);
      setSceneCaption(payload.sceneCaption);
    };

    const onPositions = (payload: {
      code: string;
      positions: TokenPosition[];
    }) => {
      if (payload.code !== code) return;
      setPositions(payload.positions);
    };

    // 被 DM 移出：服务端已经把我的连接从房间频道摘掉了，这里只能自己走
    const onKicked = (payload: { code: string; reason: string }) => {
      if (payload.code === code) setKicked(payload.reason);
    };

    /**
     * 历史消息整屏替换。
     *
     * 用替换而不是合并：这条消息的语义是「服务端认为该看到的就是这些」。
     * 合并会出事 —— 断线期间的消息在客户端以为已经收到过，
     * 或者服务端删过消息之后客户端还留着幽灵。
     */
    const onChatHistory = (payload: {
      code: string;
      messages: ChatMessageView[];
    }) => {
      if (payload.code !== code) return;
      setMessages(payload.messages);
    };

    const onChatMessage = (payload: {
      code: string;
      message: ChatMessageView;
    }) => {
      if (payload.code !== code) return;

      setMessages((prev) => {
        // 广播是「发给房间里所有人」的，包括发送者自己。
        // 如果哪天为了手感加了乐观更新，这里就会收到重复 id ——
        // 现在没有乐观更新，但去重留着，免得以后加的时候炸出重复消息
        if (prev.some((item) => item.id === payload.message.id)) return prev;

        const next = [...prev, payload.message];

        // 只留最近一屏。一局聊到几千条之后，不裁剪的话
        // 每次 setState 都要复制一个越来越长的数组
        return next.length > CHAT_HISTORY_LIMIT
          ? next.slice(next.length - CHAT_HISTORY_LIMIT)
          : next;
      });
    };

    /**
     * 待掷状态整条替换。
     *
     * 服务端这一条广播同时表达「发起」「撤销」「过期」三件事，
     * 所以客户端不需要判断 payload 是什么情况，直接照抄就行 ——
     * 这正是把它做成「一个可空状态」而不是两条事件的原因。
     */
    const onRollPending = (payload: {
      code: string;
      pending: RollPendingView | null;
    }) => {
      if (payload.code !== code) return;
      setPendingRoll(payload.pending);
      // 状态一变，上一轮的错误提示就过期了，留着只会误导
      setRollError(null);
    };

    const onRollResult = (payload: { code: string; result: RollResultView }) => {
      if (payload.code !== code) return;
      setPendingRoll(null);
      setRollResult(payload.result);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);
    socket.on("room:state", onState);
    socket.on("token:positions", onPositions);
    socket.on("room:kicked", onKicked);
    socket.on("chat:history", onChatHistory);
    socket.on("chat:message", onChatMessage);
    socket.on("roll:pending", onRollPending);
    socket.on("roll:result", onRollResult);

    // 复用已有连接时不会再触发 connect，要主动补一次订阅
    if (socket.connected) {
      setConn("online");
      subscribe();
    }

    return () => {
      socket.emit("room:leave", { code });
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      socket.off("room:state", onState);
      socket.off("token:positions", onPositions);
      socket.off("room:kicked", onKicked);
      socket.off("chat:history", onChatHistory);
      socket.off("chat:message", onChatMessage);
      socket.off("roll:pending", onRollPending);
      socket.off("roll:result", onRollResult);
      socketRef.current = null;
      releaseSocket();
    };
  }, [code]);

  // 「已进行 42 分钟」不需要秒级精度，半分钟刷一次够了
  useEffect(() => {
    setNow(Date.now());
    if (phase !== "playing") return;

    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);

  function arm(userId: string) {
    setError(null);
    setArmingId(userId);

    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(() => setArmingId(null), 4000);
  }

  function kick(userId: string) {
    if (armingId !== userId) {
      arm(userId);
      return;
    }

    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    setArmingId(null);

    startTransition(async () => {
      const result = await kickMemberAction({ code, userId });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // 乐观移除：万一实时通道正好断着，自己的列表也不会停在旧状态
      setMembers((prev) => prev.filter((item) => item.userId !== userId));
    });
  }

  /** DM 推进阶段。目标是 ended 时需要二次确认，其余单次点击 */
  function changePhase(next: RoomPhase) {
    if (next === "ended" && !armingEnd) {
      setError(null);
      setArmingEnd(true);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setArmingEnd(false), 4000);
      return;
    }

    setArmingEnd(false);
    setError(null);

    startTransition(async () => {
      const result = await setRoomPhaseAction({ code, phase: next });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setPhase(result.phase);
    });
  }

  function toggleReady() {
    if (!selfMember) return;
    const next = !selfMember.ready;

    // 就绪是个高频小动作，先本地翻转，再等服务端广播对齐
    setMembers((prev) =>
      prev.map((item) =>
        item.userId === selfId ? { ...item, ready: next } : item,
      ),
    );

    startTransition(async () => {
      const result = await toggleReadyAction({ code, ready: next });

      if (!result.ok) {
        setError(result.error);
        setMembers((prev) =>
          prev.map((item) =>
            item.userId === selfId ? { ...item, ready: !next } : item,
          ),
        );
      }
    });
  }

  /**
   * 改血量。
   *
   * 先本地改一次再发请求：扣血是高频动作，等一个来回的网络延迟才看到数字变化
   * 会让人觉得界面卡住了。真正的结果由随后的 room:state 广播纠正，
   * 所以就算本地猜错了也会在几百毫秒内对齐。
   */
  function adjustHp(member: RoomMemberView, delta: number) {
    const character = member.character;
    if (!character) return;

    const next = Math.max(
      0,
      Math.min(character.maxHp, character.currentHp + delta),
    );
    if (next === character.currentHp) return;

    setMembers((prev) =>
      prev.map((item) =>
        item.userId === member.userId && item.character
          ? { ...item, character: { ...item.character, currentHp: next } }
          : item,
      ),
    );

    startTransition(async () => {
      const result = await adjustHpAction({
        code,
        targetUserId: member.userId,
        currentHp: next,
      });

      if (!result.ok) setError(result.error);
    });
  }

  function chooseCharacter(characterId: string) {
    const picked =
      myCharacters.find((item) => item.id === characterId) ?? null;

    setMembers((prev) =>
      prev.map((item) =>
        item.userId === selfId ? { ...item, character: picked } : item,
      ),
    );

    startTransition(async () => {
      const result = await setRoomCharacterAction({
        code,
        characterId: characterId || null,
      });

      if (!result.ok) setError(result.error);
    });
  }

  /**
   * 挪自己的棋子。
   *
   * 先本地写入再发出去：拖动结束时如果等服务端广播回来，棋子会先弹回原位
   * 再跳过去，看起来像卡了一下。服务端随后广播的真实位置会覆盖本地值，
   * 所以就算本地猜错了也会在几百毫秒内对齐。
   */
  function moveToken(x: number, y: number) {
    setPositions((prev) => {
      const exists = prev.some((item) => item.userId === selfId);
      if (!exists) return [...prev, { userId: selfId, x, y }];
      return prev.map((item) =>
        item.userId === selfId ? { ...item, x, y } : item,
      );
    });

    socketRef.current?.emit("token:move", { code, x, y });
  }

  /**
   * 发一条消息。
   *
   * 用 Promise 包住 ack，因为发送按钮和回车都需要知道结果：
   * 失败时必须把草稿留在输入框里并显示原因，成功才清空。
   *
   * 加 8 秒超时兜底 —— Socket.IO 的 ack 在连接半死不活的时候
   * （比如笔记本合盖唤醒、Wi-Fi 换了网）会永远不回来。
   * 没有超时的话，发送按钮会一直转，玩家只能刷新页面。
   */
  function sendChat(body: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const socket = socketRef.current;

      if (!socket || !socket.connected) {
        resolve({ ok: false, error: "实时连接还没建立，稍等一下再发" });
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: "发送超时，检查一下网络" });
      }, 8000);

      socket.emit("chat:send", { code, body }, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        resolve(result.ok ? { ok: true } : { ok: false, error: result.error });
      });
    });
  }

  /**
   * 把一个 emit 的 ack 包成 Promise，带超时。
   *
   * Socket.IO 的 ack 在「连接半死不活」时（笔记本合盖唤醒、Wi-Fi 换网）
   * 会永远不回来。没有超时的话按钮会一直转，用户只能刷新页面。
   */
  function withAck(
    run: (done: (result: { ok: true } | { ok: false; error: string }) => void) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: "请求超时，检查一下网络" });
      }, 8000);

      run((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result.ok ? { ok: true } : { ok: false, error: result.error });
      });
    });
  }

  /**
   * DM 发起一次检定。
   *
   * 这里**不做乐观更新**：pendingRoll 要等服务端广播回来才变。
   * 因为它是一个跨用户的状态协调 —— 本地先显示「等 xin 掷」，
   * 而服务端其实拒绝了（比如对方刚退房），会让 DM 对着一个不存在的
   * 请求干等。这类状态宁可慢半拍，也不要显示一个假的东西。
   */
  function requestRoll(input: {
    targetUserId: string;
    checkKey: string;
    mode: RollMode;
    dc: number | null;
    note: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const socket = socketRef.current;

    if (!socket || !socket.connected) {
      return Promise.resolve({ ok: false, error: "实时连接还没建立" });
    }

    setRollBusy(true);
    setRollError(null);

    return withAck((done) => {
      socket.emit("roll:request", { code, ...input }, done);
    }).then((result) => {
      setRollBusy(false);
      if (!result.ok) setRollError(result.error ?? "发起失败");
      return result;
    });
  }

  function cancelRoll(): Promise<{ ok: boolean; error?: string }> {
    const socket = socketRef.current;

    if (!socket || !socket.connected) {
      return Promise.resolve({ ok: false, error: "实时连接还没建立" });
    }

    setRollBusy(true);
    setRollError(null);

    return withAck((done) => {
      socket.emit("roll:cancel", { code }, done);
    }).then((result) => {
      setRollBusy(false);
      if (!result.ok) setRollError(result.error ?? "撤销失败");
      return result;
    });
  }

  /**
   * 被指定的人按下「掷骰」。
   *
   * 注意这里**不做任何动画预演**：点下去之后什么都不发生，
   * 直到服务端把结果广播回来才开始播。
   * 如果本地先转起来，就变成「先演后算」—— 转完之后才去要结果，
   * 网络一慢骰子就得尴尬地多转一会儿，而失败时还得把数字收回去。
   */
  function executeRoll(): Promise<{ ok: boolean; error?: string }> {
    const socket = socketRef.current;

    if (!socket || !socket.connected) {
      return Promise.resolve({ ok: false, error: "实时连接还没建立" });
    }

    setRollBusy(true);
    setRollError(null);

    return withAck((done) => {
      socket.emit("roll:execute", { code }, done);
    }).then((result) => {
      setRollBusy(false);
      if (!result.ok) setRollError(result.error ?? "掷骰失败");
      return result;
    });
  }

  if (kicked) {
    return (
      <section className="rounded-xl border border-red-900/60 bg-red-950/20 px-5 py-8 text-center">
        <h2 className="font-serif text-xl text-parchment">你已被移出房间</h2>
        <p className="mt-2 text-sm text-stone-400">{kicked}</p>
        <Link
          href="/lobby"
          className="mt-6 inline-block rounded-lg bg-ember-500 px-4 py-2.5 text-[14px] font-medium text-ink-950 transition hover:bg-ember-400"
        >
          回到大厅
        </Link>
      </section>
    );
  }

  const onlineCount = members.filter((m) => m.online).length;
  // 就绪统计只算玩家。DM 是决定开始的人，不参与举手
  const players = members.filter((m) => m.role === "player");
  const readyCount = players.filter((m) => m.ready).length;
  const readyPercent = players.length > 0 ? (readyCount / players.length) * 100 : 0;

  return (
    <section>
      <PhaseBanner
        phase={phase}
        startedAt={startedAt}
        now={now}
        players={players.length}
        readyCount={readyCount}
        readyPercent={readyPercent}
        caps={caps}
        selfRole={selfRole}
        selfReady={selfMember?.ready ?? false}
        pending={pending}
        armingEnd={armingEnd}
        onChangePhase={changePhase}
        onToggleReady={toggleReady}
      />

      {phase === "playing" ? (
        <>
          <StageView
            code={code}
            selfId={selfId}
            hostId={hostId}
            members={members}
            positions={positions}
            scene={{ backgroundKey, backgroundImage, backgroundFit, sceneCaption }}
            canChangeScene={caps.canChangeScene}
            onMove={moveToken}
            onAdjustHp={adjustHp}
            onRequestScenePanel={() => setScenePanelOpen((prev) => !prev)}
            scenePanelOpen={scenePanelOpen}
            onSceneSaved={(next) => {
              setBackgroundKey(next.backgroundKey);
              setBackgroundImage(next.backgroundImage);
              setBackgroundFit(next.backgroundFit);
              setSceneCaption(next.sceneCaption);
            }}
          />

          {/*
            操作区放在舞台**下方**、聊天**上方**。

            上一版把这块放在舞台上面，理由是「此刻该做什么」要最先被看到。
            但跑团的实际操作顺序是反的：眼睛先落在战场上（谁在哪、血多少），
            手再往下走（我要做什么 → 说一句话）。把操作条顶在视野最上方，
            等于每次要求检定都要先把视线从地图上拽回页首，
            再拉回聊天框 —— 一晚上重复几十次的动作，顺序错了就是损耗。

            放在这里之后，「地图 → 骰子 → 聊天」三者从上到下正好是
            一局游戏的信息流：看到什么 → 掷什么 → 说什么。
          */}
          {pendingRoll ? (
            <RollPendingBar
              pending={pendingRoll}
              isTarget={pendingRoll.targetUserId === selfId}
              isDm={selfRole === "dm"}
              busy={rollBusy}
              error={rollError}
              onRoll={() => void executeRoll()}
              onCancel={() => void cancelRoll()}
            />
          ) : null}

          {selfRole === "dm" ? (
            <RollRequestPanel
              members={members}
              hasPending={pendingRoll !== null}
              onRequest={requestRoll}
            />
          ) : null}
        </>
      ) : (
        <>
      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-[13px] font-medium tracking-wide text-stone-400">
          房间里的人
          <span className="ml-2 text-stone-600">
            {onlineCount}/{members.length} 在线
          </span>
        </h2>

        <span className="flex items-center gap-1.5 text-[12px] text-stone-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[conn]}`}
            aria-hidden
          />
          {STATUS_LABEL[conn]}
        </span>
      </div>

      <ul className="mt-3 space-y-2">
        {members.map((member) => {
          const isSelf = member.userId === selfId;
          const canAdjustHp = isSelf || caps.canKick;

          return (
            <li
              key={member.userId}
              className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                <span className="relative h-9 w-9 shrink-0">
                  <CharacterToken
                    portrait={member.character?.portrait ?? DEFAULT_PORTRAIT}
                    name={member.character?.name || member.displayName}
                    className="h-full w-full"
                    dimmed={!member.online}
                    ring={member.role === "dm" ? "#E0B457" : undefined}
                  />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] text-parchment">
                      {member.displayName}
                    </span>
                    {isSelf ? (
                      <span className="text-[12px] text-stone-500">（你）</span>
                    ) : null}

                    {member.role === "dm" ? (
                      <span className="rounded border border-ember-600/60 bg-ember-600/10 px-1.5 py-0.5 text-[11px] text-ember-400">
                        DM
                      </span>
                    ) : (
                      <span className="rounded border border-ink-700 px-1.5 py-0.5 text-[11px] text-stone-500">
                        玩家
                      </span>
                    )}

                    {member.role === "player" && phase === "preparing" ? (
                      <span
                        className={`ml-0.5 h-1.5 w-1.5 rounded-full ${
                          member.ready ? "bg-emerald-500" : "bg-ink-700"
                        }`}
                        title={member.ready ? "已就绪" : "还没准备好"}
                        aria-label={member.ready ? "已就绪" : "还没准备好"}
                      />
                    ) : null}
                  </div>

                  {member.character ? (
                    <CharacterLine
                      character={member.character}
                      canAdjustHp={canAdjustHp}
                      onAdjust={(delta) => adjustHp(member, delta)}
                    />
                  ) : (
                    <p className="mt-0.5 text-[12px] text-stone-600">
                      还没有角色卡
                    </p>
                  )}
                </div>

                {caps.canKick && !isSelf && member.role !== "dm" ? (
                  <button
                    type="button"
                    onClick={() => kick(member.userId)}
                    disabled={pending}
                    className={`shrink-0 rounded border px-2 py-0.5 text-[11px] transition disabled:opacity-50 ${
                      armingId === member.userId
                        ? "border-red-700 bg-red-900/40 text-red-300"
                        : "border-ink-700 text-stone-500 hover:border-red-900 hover:text-red-400"
                    }`}
                  >
                    {armingId === member.userId ? "确认移出" : "移出"}
                  </button>
                ) : null}
              </div>

              {isSelf ? (
                <div className="mt-2 space-y-1.5 border-t border-ink-800/70 pt-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={selfMember?.character?.id ?? ""}
                      onChange={(event) => chooseCharacter(event.target.value)}
                      disabled={pending || !caps.canSwitchCharacter}
                      className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1.5 text-[13px] text-parchment outline-none focus:border-ember-500 disabled:opacity-60"
                    >
                      <option value="">不使用角色卡</option>
                      {myCharacters.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name || "未命名"}（{item.className} {item.level} 级）
                        </option>
                      ))}
                    </select>

                    <Link
                      href="/characters"
                      className="shrink-0 rounded-md border border-ink-700 px-2 py-1.5 text-[12px] text-stone-400 transition hover:border-ember-600 hover:text-ember-400"
                    >
                      {myCharacters.length === 0 ? "建一张" : "管理"}
                    </Link>
                  </div>

                  {/* 进行中已经切到舞台视图，这个列表只在准备/结束阶段渲染，
                      所以这里能出现的只有「已结束」 */}
                  {phase === "ended" ? (
                    <p className="text-[11px] text-stone-600">
                      本局已结束，角色卡不可更改
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
        </>
      )}

      {/*
        聊天放在两个阶段的分支之外，所以准备阶段和进行中都有 ——
        「你打算玩什么职业」这类对话全发生在开局之前，
        如果只在舞台里给聊天入口，最需要沟通的时候反而说不了话。
      */}
      <ChatPanel
        messages={chatMessages}
        selfId={selfId}
        connected={conn === "online"}
        readOnly={phase === "ended"}
        onSend={sendChat}
      />

      {error ? <p className="mt-2 text-[12px] text-red-400">{error}</p> : null}

      {conn === "offline" ? (
        <p className="mt-2 text-[12px] text-stone-600">
          实时通道断开，成员列表不会自动更新 · 确认 socket 进程已启动
        </p>
      ) : null}

      {/*
        掷骰浮层挂在这里、而不是挂进舞台。
        它用 fixed 覆盖整个视口 —— 跑团时掷骰是「打断当前一切」的时刻，
        所有人的注意力都该在那一颗骰子上。塞在舞台里会让它变成
        一块需要被寻找的小区域，那种仪式感就没了。
      */}
      <DiceRollOverlay result={rollResult} onClose={() => setRollResult(null)} />
    </section>
  );
}

/**
 * 阶段横幅：现在是什么阶段、还能做什么、DM 的推进按钮。
 *
 * 这块是整个「开始/结束」设计的落点。它不是装饰 ——
 * 横幅上的按钮直接对应权限变化，玩家看到「准备中」就知道自己还能改卡，
 * 看到「进行中」就知道属性锁了。
 */
function PhaseBanner({
  phase,
  startedAt,
  now,
  players,
  readyCount,
  readyPercent,
  caps,
  selfRole,
  selfReady,
  pending,
  armingEnd,
  onChangePhase,
  onToggleReady,
}: {
  phase: RoomPhase;
  startedAt: number | null;
  now: number | null;
  players: number;
  readyCount: number;
  readyPercent: number;
  caps: ReturnType<typeof phaseCapabilities>;
  selfRole: "dm" | "player" | null;
  selfReady: boolean;
  pending: boolean;
  armingEnd: boolean;
  onChangePhase: (next: RoomPhase) => void;
  onToggleReady: () => void;
}) {
  const style = PHASE_STYLE[phase];
  const elapsed =
    phase === "playing" && startedAt && now
      ? formatElapsed(startedAt, now)
      : null;

  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} px-4 py-3.5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
            <span className={`text-[13px] font-medium ${style.text}`}>
              {PHASE_LABEL[phase]}
            </span>
            {elapsed ? (
              <span className="text-[12px] text-stone-500">{elapsed}</span>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-stone-500">{phaseHint(phase)}</p>
        </div>

        <div className="flex items-center gap-2">
          {caps.canStart ? (
            <button
              type="button"
              onClick={() => onChangePhase("playing")}
              disabled={pending}
              className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[13px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:opacity-50"
            >
              开始游戏
            </button>
          ) : null}

          {caps.canEnd ? (
            <button
              type="button"
              onClick={() => onChangePhase("ended")}
              disabled={pending}
              className={`rounded-lg border px-3 py-1.5 text-[13px] transition disabled:opacity-50 ${
                armingEnd
                  ? "border-red-700 bg-red-900/40 text-red-300"
                  : "border-ink-700 text-stone-400 hover:border-red-900 hover:text-red-400"
              }`}
            >
              {armingEnd ? "确认结束" : "结束本局"}
            </button>
          ) : null}

          {caps.canReopen ? (
            <button
              type="button"
              onClick={() => onChangePhase("preparing")}
              disabled={pending}
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-[13px] text-stone-400 transition hover:border-ember-600 hover:text-ember-400 disabled:opacity-50"
            >
              回到准备
            </button>
          ) : null}
        </div>
      </div>

      {phase === "preparing" && players > 0 ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-stone-500">
              {readyCount}/{players} 位玩家已就绪
            </span>

            {caps.canToggleReady ? (
              <button
                type="button"
                onClick={onToggleReady}
                disabled={pending}
                className={`rounded-md border px-2.5 py-1 text-[12px] transition disabled:opacity-50 ${
                  selfReady
                    ? "border-emerald-800 bg-emerald-950/40 text-emerald-300"
                    : "border-ink-700 text-stone-400 hover:border-emerald-800 hover:text-emerald-400"
                }`}
              >
                {selfReady ? "我已就绪 · 取消" : "我准备好了"}
              </button>
            ) : selfRole === "dm" ? (
              <span className="text-[11px] text-stone-600">
                你来决定何时开始
              </span>
            ) : null}
          </div>

          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all duration-300"
              style={{ width: `${readyPercent}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 成员行里的角色摘要：名字、职业等级、血量、AC。
 *
 * 这里显示的都是公开字段。属性、装备、背景故事属于「细节」，
 * 只有本人和 DM 能看，所以不在这个列表里出现，
 * 也不会随着广播发给房间里的其他人。
 */
function CharacterLine({
  character,
  canAdjustHp,
  onAdjust,
}: {
  character: CharacterSummary;
  canAdjustHp: boolean;
  onAdjust: (delta: number) => void;
}) {
  const ratio =
    character.maxHp > 0 ? character.currentHp / character.maxHp : 0;

  const hpColor =
    character.currentHp <= 0
      ? "text-red-400"
      : ratio < 0.3
        ? "text-amber-400"
        : "text-parchment";

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <span className="max-w-[10rem] truncate text-stone-300">
        {character.name}
      </span>
      <span className="text-stone-600">
        {character.className} {character.level} 级
      </span>

      <span className="inline-flex items-center gap-1">
        {canAdjustHp ? (
          <button
            type="button"
            onClick={() => onAdjust(-1)}
            className="flex h-4 w-4 items-center justify-center rounded border border-ink-700 text-[11px] leading-none text-stone-400 transition hover:border-red-900 hover:text-red-400"
            aria-label="生命值减一"
          >
            −
          </button>
        ) : null}

        <span className={`tabular-nums ${hpColor}`}>
          {character.currentHp}/{character.maxHp}
        </span>

        {canAdjustHp ? (
          <button
            type="button"
            onClick={() => onAdjust(1)}
            className="flex h-4 w-4 items-center justify-center rounded border border-ink-700 text-[11px] leading-none text-stone-400 transition hover:border-emerald-800 hover:text-emerald-400"
            aria-label="生命值加一"
          >
            +
          </button>
        ) : null}
      </span>

      <span className="text-stone-500">AC {character.ac}</span>
    </div>
  );
}
