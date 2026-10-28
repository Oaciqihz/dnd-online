"use client";

import { useMemo, useRef, useState } from "react";
import { CharacterToken } from "./character-token";
import { DEFAULT_PORTRAIT } from "@/lib/portrait";
import { SCENES, findScene } from "@/lib/scenes";
import { imageRefUrl, MAX_MAP_UPLOAD_BYTES } from "@/lib/media/ref";
import type { RoomMemberView, TokenPosition } from "@/lib/protocol";
import { setSceneAction } from "@/app/actions/rooms";

/**
 * 场景的四个值。它们共同决定舞台长什么样，所以永远整组传递 ——
 * 只传其中一个会让接收方拿新值和旧状态拼出一个从未存在过的画面。
 */
export type SceneValues = {
  backgroundKey: string;
  backgroundImage: string;
  backgroundFit: "cover" | "contain";
  sceneCaption: string;
};

/**
 * 进行中的舞台。
 *
 * 这是「准备阶段 vs 进行阶段」两种布局的另一半：同一个房间页、
 * 同一条 Socket 连接、同一份成员数据，只是渲染的子树不同。
 * 不做成两个 URL，否则切换时会丢掉滚动位置和没发出去的输入，
 * 而且「进行中查看角色卡」就得另造一套导航。
 *
 * 棋子用绝对定位的 DOM + SVG，不是 canvas —— 理由见 character-token.tsx。
 */
export function StageView({
  code,
  selfId,
  hostId,
  members,
  positions,
  scene,
  canChangeScene,
  onMove,
  onAdjustHp,
  onRequestScenePanel,
  scenePanelOpen,
  onSceneSaved,
}: {
  code: string;
  selfId: string;
  hostId: string;
  members: RoomMemberView[];
  positions: TokenPosition[];
  scene: SceneValues;
  canChangeScene: boolean;
  onMove: (x: number, y: number) => void;
  onAdjustHp: (member: RoomMemberView, delta: number) => void;
  onRequestScenePanel: () => void;
  scenePanelOpen: boolean;
  onSceneSaved: (next: SceneValues) => void;
}) {
  const preset = findScene(scene.backgroundKey);
  const backdrop = imageRefUrl(scene.backgroundImage);
  const stageRef = useRef<HTMLDivElement>(null);

  /** 抽屉里展示谁的角色卡。null 表示收起 */
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * 正在拖动的那颗棋子的临时位置。
   *
   * 只存「正在拖的那一个」，其余一律读服务端广播来的位置。
   * 这样拖动过程中别人挪棋子、或者 room:state 重播，都不会把手指下的棋子拽走；
   * 松手后通过父组件的乐观更新接管，也不会出现回弹。
   */
  const [dragPoint, setDragPoint] = useState<{
    userId: string;
    x: number;
    y: number;
  } | null>(null);

  const positionMap = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const item of positions) map.set(item.userId, { x: item.x, y: item.y });
    return map;
  }, [positions]);

  /**
   * 注意这里刻意没有「positions 变化就清空 dragPoint」的 effect。
   * 那样写的效果是：别人一挪棋子，正在拖的自己就被打断 ——
   * dragPoint 变 null，handleMove 直接 return，手指还在按着但棋子不动了。
   * 所以临时状态只由 pointer 事件自己收尾。
   */
  function handleDown(event: React.PointerEvent, userId: string) {
    // 只能拖自己那一颗。服务端也只接受自己的位置，
    // 但在这里就挡住，能省掉一次无效的网络往返
    if (userId !== selfId) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    // 从当前位置起步。如果只是点一下没拖，松手时提交的就是原位，等于没动 ——
    // 这里如果写成固定坐标，单击就会把棋子瞬间挪到舞台中央
    const current = positionMap.get(userId) ?? { x: 50, y: 62 };
    setDragPoint({ userId, x: current.x, y: current.y });
  }

  function handleMove(event: React.PointerEvent, userId: string) {
    if (!dragPoint || dragPoint.userId !== userId || !stageRef.current) return;

    const rect = stageRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;

    setDragPoint({ userId, x, y });
  }

  function handleUp(event: React.PointerEvent, userId: string) {
    if (!dragPoint || dragPoint.userId !== userId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);

    // 夹在和服务端一致的范围内，避免松手瞬间棋子跳到边缘
    onMove(
      Math.min(95, Math.max(5, dragPoint.x)),
      Math.min(90, Math.max(24, dragPoint.y)),
    );

    setDragPoint(null);
  }

  const open = members.find((item) => item.userId === openId) ?? null;

  return (
    <section className="mt-6">
      <SceneBar
        label={backdrop ? "自定义地图" : preset.label}
        caption={scene.sceneCaption}
        canChange={canChangeScene}
        onToggle={onRequestScenePanel}
        open={scenePanelOpen}
      />

      {scenePanelOpen && canChangeScene ? (
        <ScenePanel code={code} initial={scene} onSaved={onSceneSaved} />
      ) : null}

      <div
        ref={stageRef}
        className="relative mt-3 overflow-hidden rounded-xl border border-ink-700"
        style={{
          background: preset.background,
          aspectRatio: "16 / 9",
          touchAction: "none",
        }}
      >
        {/*
          DM 上传的地图铺在渐变之上。

          contain 时图不会填满，四周露出的是下面那层渐变 —— 这正是要的效果：
          完整显示一张方图时，留出来的是「场景底色」而不是黑边。
          图加载失败时同理，舞台仍然是那个场景，不会黑屏。
        */}
        {backdrop ? (
          <img
            src={backdrop}
            alt=""
            aria-hidden
            draggable={false}
            className={`pointer-events-none absolute inset-0 h-full w-full select-none ${
              scene.backgroundFit === "contain" ? "object-contain" : "object-cover"
            }`}
          />
        ) : null}

        {/*
          压暗层。玩家传的地图多半是亮底的，浅色的棋子名和饼边放上去就糊了。
          顶部压得更重（DM 的场景条在视觉上等于光源方向），底部略压，
          中间几乎不动 —— 那是地图信息最密集的地方。

          只在有图时加：内置渐变本身已经带暗角，再压一次就成了黑块。
        */}
        {backdrop ? (
          <div
            className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/45 via-black/5 to-black/30"
            aria-hidden
          />
        ) : null}

        {/* 地面：底部一层更亮的颜色，让棋子看起来是站着而不是浮着 */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5"
          style={{
            background: `linear-gradient(to top, ${preset.floor}, transparent)`,
          }}
          aria-hidden
        />

        {members.map((member) => {
          const point =
            dragPoint?.userId === member.userId
              ? dragPoint
              : (positionMap.get(member.userId) ?? { x: 50, y: 62 });
          const isSelf = member.userId === selfId;
          const isDm = member.role === "dm";

          return (
            <div
              key={member.userId}
              className="absolute flex w-[clamp(46px,10%,80px)] -translate-x-1/2 -translate-y-1/2 flex-col items-center"
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
            >
              <div
                onPointerDown={(event) => handleDown(event, member.userId)}
                onPointerMove={(event) => handleMove(event, member.userId)}
                onPointerUp={(event) => handleUp(event, member.userId)}
                onPointerCancel={() =>
                  setDragPoint((prev) =>
                    prev?.userId === member.userId ? null : prev,
                  )
                }
                onClick={() => setOpenId(member.userId)}
                className={`w-full ${
                  isSelf ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                }`}
                role="button"
                tabIndex={0}
                aria-label={`${member.displayName} 的角色`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setOpenId(member.userId);
                  }
                }}
              >
                <CharacterToken
                  portrait={member.character?.portrait ?? DEFAULT_PORTRAIT}
                  name={member.character?.name || member.displayName}
                  className="w-full"
                  dimmed={!member.online}
                  ring={isDm ? "#E0B457" : isSelf ? "#F0EAD8" : undefined}
                />
              </div>

              <span
                className={`mt-0.5 max-w-full truncate rounded px-1 text-[10px] leading-tight backdrop-blur-sm ${
                  isSelf ? "bg-black/55 text-parchment" : "bg-black/40 text-stone-300"
                }`}
              >
                {member.character?.name || member.displayName}
              </span>
            </div>
          );
        })}

        {members.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center text-[13px] text-stone-500">
            房间里还没有人
          </p>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] text-stone-600">
        拖自己的棋子可以移动位置 · 点任意棋子查看角色卡
      </p>

      <ul className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {members.map((member) => {
          const character = member.character;
          const ratio = character && character.maxHp > 0 ? character.currentHp / character.maxHp : 1;
          const hpColor =
            character && character.currentHp <= 0
              ? "text-red-400"
              : ratio < 0.3
                ? "text-amber-400"
                : "text-stone-300";

          return (
            <li key={member.userId} className="shrink-0">
              <button
                type="button"
                onClick={() => setOpenId(member.userId)}
                className={`flex w-[132px] items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                  openId === member.userId
                    ? "border-ember-600/70 bg-ember-600/10"
                    : "border-ink-800 bg-ink-900/60 hover:border-ink-700"
                }`}
              >
                <span className="h-8 w-8 shrink-0">
                  <CharacterToken
                    portrait={character?.portrait ?? DEFAULT_PORTRAIT}
                    name={character?.name || member.displayName}
                    className="h-full w-full"
                    dimmed={!member.online}
                    ring={member.role === "dm" ? "#E0B457" : undefined}
                  />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-parchment">
                    {character?.name || member.displayName}
                  </span>
                  <span className={`block text-[11px] tabular-nums ${hpColor}`}>
                    {character ? `${character.currentHp}/${character.maxHp}` : "无卡"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {open ? (
        <CharacterDrawer
          member={open}
          selfId={selfId}
          isDm={open.userId === hostId}
          onClose={() => setOpenId(null)}
          onAdjustHp={onAdjustHp}
        />
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------- 场景条 */

function SceneBar({
  label,
  caption,
  canChange,
  onToggle,
  open,
}: {
  label: string;
  caption: string;
  canChange: boolean;
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-ink-800 bg-ink-900/50 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded border border-ember-600/50 bg-ember-600/10 px-1.5 py-0.5 text-[11px] text-ember-400">
            {label}
          </span>
          <span className="text-[11px] text-stone-600">当前场景</span>
        </div>

        <p className="mt-1.5 text-[13px] leading-relaxed text-stone-300">
          {caption || (
            <span className="text-stone-600">
              {canChange ? "写一句场景描述，比如「你们推开沉重的木门」" : "DM 还没设置场景"}
            </span>
          )}
        </p>
      </div>

      {canChange ? (
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-stone-400 transition hover:border-ember-600 hover:text-ember-400"
        >
          {open ? "收起" : "切换场景"}
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- 场景面板 */

function ScenePanel({
  code,
  initial,
  onSaved,
}: {
  code: string;
  initial: SceneValues;
  onSaved: (next: SceneValues) => void;
}) {
  /**
   * 四个值是本地草稿，点「保存场景」才一起提交。
   *
   * 只有 source 是特殊的：它不写库，但决定了「保存时用内置渐变还是用地图」。
   * 之所以要显式选它，见 lib/rooms.ts 里 SceneInput 的说明 ——
   * DM 传过图之后 backgroundKey 仍然有值，光看 key 判断不出他想要哪个。
   */
  const [source, setSource] = useState<"builtin" | "upload">(
    initial.backgroundImage ? "upload" : "builtin",
  );
  const [key, setKey] = useState(initial.backgroundKey);
  const [fit, setFit] = useState<"cover" | "contain">(initial.backgroundFit);
  const [text, setText] = useState(initial.sceneCaption);
  const [image, setImage] = useState(initial.backgroundImage);

  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const hasImage = image.trim().length > 0;
  const imageUrl = imageRefUrl(image);

  async function submit() {
    setPending(true);
    setError(null);

    const result = await setSceneAction({
      code,
      source,
      backgroundKey: key,
      fit,
      caption: text,
    });

    setPending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    onSaved({
      backgroundKey: result.backgroundKey,
      backgroundImage: result.backgroundImage,
      backgroundFit: result.backgroundFit,
      sceneCaption: result.sceneCaption,
    });
  }

  /**
   * 上传即生效，不等「保存场景」。
   *
   * 因为 DM 传完图之后最想做的事就是「看看它在舞台上什么样」，
   * 如果还要再点一次保存才能看到，那这次上传就没有反馈。
   */
  async function upload(file: File) {
    if (file.size > MAX_MAP_UPLOAD_BYTES) {
      setError(
        `地图不能超过 ${Math.round(MAX_MAP_UPLOAD_BYTES / 1024 / 1024)}MB`,
      );
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("fit", fit);

      const response = await fetch(`/api/rooms/${code}/scene`, {
        method: "POST",
        body: form,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setError(data?.error ?? "上传失败，请重试");
        return;
      }

      setImage(data.backgroundImage);
      setSource("upload");
      onSaved({
        backgroundKey: data.backgroundKey,
        backgroundImage: data.backgroundImage,
        backgroundFit: data.backgroundFit,
        sceneCaption: data.sceneCaption,
      });
    } catch {
      setError("网络异常，请重试");
    } finally {
      setUploading(false);
    }
  }

  async function removeMap() {
    setUploading(true);
    setError(null);

    try {
      const response = await fetch(`/api/rooms/${code}/scene`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setError(data?.error ?? "移除失败，请重试");
        return;
      }

      setImage("");
      setSource("builtin");
      onSaved({
        backgroundKey: data.backgroundKey,
        backgroundImage: "",
        backgroundFit: data.backgroundFit,
        sceneCaption: data.sceneCaption,
      });
    } catch {
      setError("网络异常，请重试");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-ink-800 bg-ink-900/70 p-3.5">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] tracking-wide text-stone-500">内置场景</p>
        <p className="text-[11px] text-stone-600">零加载，切换即时</p>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {SCENES.map((item) => {
          const selected = source === "builtin" && key === item.key;

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setKey(item.key);
                setSource("builtin");
              }}
              title={item.hint}
              className={`overflow-hidden rounded-lg border text-left transition ${
                selected
                  ? "border-ember-500 ring-1 ring-ember-500/40"
                  : "border-ink-800 hover:border-ink-700"
              }`}
            >
              <span
                className="block h-10 w-full"
                style={{ background: item.background }}
                aria-hidden
              />
              <span className="block px-2 py-1 text-[11px] text-stone-400">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-baseline justify-between">
        <p className="text-[11px] tracking-wide text-stone-500">我的地图</p>
        <p className="text-[11px] text-stone-600">长边至少 320px</p>
      </div>

      {hasImage ? (
        <div
          className={`mt-2 flex gap-2.5 rounded-lg border p-2 transition ${
            source === "upload"
              ? "border-ember-500 ring-1 ring-ember-500/40"
              : "border-ink-800"
          }`}
        >
          <button
            type="button"
            onClick={() => setSource("upload")}
            aria-label="使用这张地图"
            className="h-16 w-24 shrink-0 overflow-hidden rounded border border-ink-700"
          >
            {/* 缩略图用同一套 object-* 类，DM 能大致看出 cover / contain 的区别 */}
            <img
              src={imageUrl}
              alt=""
              className={`h-full w-full ${
                fit === "contain" ? "object-contain" : "object-cover"
              }`}
            />
          </button>

          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-stone-300">当前地图</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-stone-600">
              {source === "upload"
                ? "保存后舞台上显示这张图"
                : "点左侧缩略图切换回这张图"}
            </p>

            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="text-[12px] text-ember-400 transition hover:text-ember-300 disabled:opacity-50"
              >
                {uploading ? "处理中…" : "换一张"}
              </button>
              <button
                type="button"
                onClick={removeMap}
                disabled={uploading}
                className="text-[12px] text-stone-500 transition hover:text-red-400 disabled:opacity-50"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="mt-2 flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-ink-700 text-[12px] text-stone-500 transition hover:border-ember-600 hover:text-ember-400 disabled:opacity-50"
        >
          {uploading
            ? "上传中…"
            : `上传地图图片（PNG / JPG，最大 ${Math.round(MAX_MAP_UPLOAD_BYTES / 1024 / 1024)}MB）`}
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // 清空 value，否则「换一张」时选同一个文件不会再触发 change
          event.target.value = "";
          if (file) void upload(file);
        }}
      />

      {hasImage ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-stone-500">显示方式</span>
          {(
            [
              ["cover", "裁切填满", "铺满舞台，边缘会被切掉"],
              ["contain", "完整显示", "看到整张图，四周留出场景底色"],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFit(value)}
              title={hint}
              className={`rounded-md border px-2 py-1 transition ${
                fit === value
                  ? "border-ember-500 bg-ember-600/15 text-ember-300"
                  : "border-ink-700 text-stone-400 hover:border-ink-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={120}
        placeholder="一句场景描述，比如「你们推开沉重的木门，一股霉味涌出来」"
        className="mt-3 w-full rounded-md border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-[13px] text-parchment outline-none placeholder:text-stone-600 focus:border-ember-500"
      />

      <div className="mt-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || uploading}
          className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[13px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:opacity-50"
        >
          {pending ? "保存中…" : "保存场景"}
        </button>
        {error ? <span className="text-[12px] text-red-400">{error}</span> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- 抽屉 */

function CharacterDrawer({
  member,
  selfId,
  isDm,
  onClose,
  onAdjustHp,
}: {
  member: RoomMemberView;
  selfId: string;
  isDm: boolean;
  onClose: () => void;
  onAdjustHp: (member: RoomMemberView, delta: number) => void;
}) {
  const character = member.character;
  const isSelf = member.userId === selfId;

  return (
    <div className="mt-3 rounded-xl border border-ink-700 bg-ink-900/80 p-4">
      <div className="flex items-start gap-4">
        <div className="h-16 w-16 shrink-0">
          <CharacterToken
            portrait={character?.portrait ?? DEFAULT_PORTRAIT}
            name={character?.name || member.displayName}
            className="h-full w-full"
            dimmed={!member.online}
            ring={isDm ? "#E0B457" : undefined}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-serif text-[17px] text-parchment">
              {character?.name || member.displayName}
            </h3>
            {isDm ? (
              <span className="rounded border border-ember-600/60 bg-ember-600/10 px-1.5 py-0.5 text-[11px] text-ember-400">
                DM
              </span>
            ) : null}
            {isSelf ? <span className="text-[12px] text-stone-500">（你）</span> : null}
          </div>

          <p className="mt-0.5 text-[12px] text-stone-500">
            {member.displayName}
            {character
              ? ` · ${character.ancestry || "未知种族"} ${character.className} ${character.level} 级`
              : " · 还没有角色卡"}
          </p>

          {character ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
              <span className="inline-flex items-center gap-1.5">
                <span className="text-stone-500">HP</span>
                <button
                  type="button"
                  onClick={() => onAdjustHp(member, -1)}
                  className="flex h-4 w-4 items-center justify-center rounded border border-ink-700 text-[11px] leading-none text-stone-400 transition hover:border-red-900 hover:text-red-400"
                  aria-label="生命值减一"
                >
                  −
                </button>
                <span className="tabular-nums text-parchment">
                  {character.currentHp}/{character.maxHp}
                </span>
                <button
                  type="button"
                  onClick={() => onAdjustHp(member, 1)}
                  className="flex h-4 w-4 items-center justify-center rounded border border-ink-700 text-[11px] leading-none text-stone-400 transition hover:border-emerald-800 hover:text-emerald-400"
                  aria-label="生命值加一"
                >
                  +
                </button>
              </span>

              <span className="text-stone-400">
                AC <span className="tabular-nums text-parchment">{character.ac}</span>
              </span>

              {character.tempHp > 0 ? (
                <span className="text-stone-400">
                  临时 HP <span className="tabular-nums text-sky-300">{character.tempHp}</span>
                </span>
              ) : null}

              <span className="text-stone-600">
                {member.online ? "在线" : "离线"}
              </span>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-ink-700 px-2 py-0.5 text-[11px] text-stone-500 transition hover:border-ink-600 hover:text-stone-300"
        >
          收起
        </button>
      </div>

      {character ? (
        <p className="mt-3 border-t border-ink-800/70 pt-2.5 text-[11px] text-stone-600">
          {isSelf
            ? "完整属性、熟练、装备在你自己的角色卡页里"
            : isDm
              ? "DM 可以查看所有人的完整卡，入口在房间成员列表"
              : "属性、装备、背景只有本人和 DM 能看"}
        </p>
      ) : null}
    </div>
  );
}
