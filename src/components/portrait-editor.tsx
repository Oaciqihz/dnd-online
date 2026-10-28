"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { savePortraitAction } from "@/app/actions/characters";
import {
  PORTRAIT_FRAMES,
  PORTRAIT_STYLES,
  hasUploadedImage,
  needsAttribution,
  type Portrait,
  type PortraitFrame,
  type PortraitStyle,
} from "@/lib/portrait";
import { CharacterToken } from "./character-token";

/**
 * 舞台形象编辑器。
 *
 * 三条路并存，因为它们解决的是三种不同的需求：
 *
 * - 上传：玩家心里已经有一个具体的角色形象（自己的画、找的图、AI 生成的）
 * - 生成：玩家只想「有个像样的脸」，不想为一张图折腾
 * - 边框：没有图也能表达自己，而且这是让一堆风格各异的图看起来
 *   像同一套棋子的关键 —— 统一边框比统一画风容易得多
 *
 * 交互上有一个刻意的取舍：**上传立即生效，风格/边框要点保存**。
 *
 * 上传是「动作」，玩家选了文件就在等结果，再让他去点一次保存是多余的一步；
 * 而风格和边框是「调参」，玩家会来回试几个，每次都落库会产生大量无意义的写。
 */

type UploadState = "idle" | "uploading" | "removing";

export function PortraitEditor({
  characterId,
  initialPortrait,
  characterName,
}: {
  characterId: string;
  initialPortrait: Portrait;
  characterName: string;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [portrait, setPortrait] = useState<Portrait>(initialPortrait);
  /**
   * 「已保存」的对比基线。
   *
   * 不能直接拿 props.initialPortrait 当基线：上传成功后我们会 router.refresh()，
   * 服务端会重新渲染并传来新的 initialPortrait，但 useState 只在挂载时读一次 props，
   * 本地状态不会跟着变 —— 于是 dirty 会永远为 true，保存按钮一直亮着。
   * 用一份自己的基线，上传和保存时手动同步，语义才是一致的。
   */
  const [baseline, setBaseline] = useState<Portrait>(initialPortrait);

  const [saving, startTransition] = useTransition();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = JSON.stringify(portrait) !== JSON.stringify(baseline);
  const busy = uploadState !== "idle" || saving;

  function patch(update: Partial<Portrait>) {
    setPortrait((prev) => ({ ...prev, ...update }));
    setError(null);
    setNotice(null);
  }

  /* ------------------------------------------------------------ 上传 */

  async function upload(file: File) {
    setUploadState("uploading");
    setError(null);
    setNotice(null);

    try {
      const form = new FormData();
      form.append("file", file);
      // 把本地还没保存的风格/边框一起带上，
      // 否则「先挑了边框、再传图」会被服务端用旧配置覆盖掉
      form.append("portrait", JSON.stringify(portrait));

      const response = await fetch(`/api/characters/${characterId}/portrait`, {
        method: "POST",
        body: form,
      });

      const json = (await response.json().catch(() => null)) as
        | { ok: boolean; error?: string; portrait?: Portrait }
        | null;

      if (!response.ok || !json?.ok || !json.portrait) {
        setError(json?.error ?? "上传失败了，换个图再试试");
        return;
      }

      setPortrait(json.portrait);
      setBaseline(json.portrait);
      setNotice("图片已更新，房间里所有人都能看到");
      router.refresh();
    } catch {
      setError("网络中断，图片没传上去");
    } finally {
      setUploadState("idle");
    }
  }

  async function removeImage() {
    setUploadState("removing");
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/characters/${characterId}/portrait`, {
        method: "DELETE",
      });

      const json = (await response.json().catch(() => null)) as
        | { ok: boolean; error?: string; portrait?: Portrait }
        | null;

      if (!response.ok || !json?.ok || !json.portrait) {
        setError(json?.error ?? "移除失败了");
        return;
      }

      setPortrait(json.portrait);
      setBaseline(json.portrait);
      setNotice("已换回生成头像");
      router.refresh();
    } catch {
      setError("网络中断");
    } finally {
      setUploadState("idle");
    }
  }

  /* ------------------------------------------------------------ 保存 */

  function save() {
    startTransition(async () => {
      const result = await savePortraitAction({ characterId, portrait });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setBaseline(portrait);
      setNotice("已保存");
      router.refresh();
    });
  }

  const style = PORTRAIT_STYLES.find((item) => item.key === portrait.style);
  const hasImage = hasUploadedImage(portrait);

  return (
    <div className="grid gap-6 sm:grid-cols-[168px_1fr]">
      {/* ------------------------------------------------------- 预览 */}
      <div className="flex flex-col items-center gap-3">
        <div className="w-[168px]">
          <CharacterToken
            portrait={portrait}
            name={characterName}
            className="w-full"
          />
        </div>

        <p className="max-w-[168px] truncate text-center text-[12px] text-stone-500">
          {characterName || "未命名"}
        </p>

        <p className="text-center text-[11px] text-stone-600">
          {hasImage ? "你的图片" : `生成 · ${style?.label ?? "奇幻"}`}
        </p>
      </div>

      {/* ------------------------------------------------------- 操作 */}
      <div className="space-y-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // 传完必须清空 value，否则选同一个文件第二次不会触发 change ——
                // 玩家「重传一张刚才失败过的图」时会以为按钮坏了
                event.target.value = "";
                if (file) void upload(file);
              }}
            />

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[13px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:opacity-50"
            >
              {uploadState === "uploading" ? "上传中…" : "上传图片"}
            </button>

            {hasImage ? (
              <button
                type="button"
                onClick={removeImage}
                disabled={busy}
                className="rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-stone-400 transition hover:border-red-900 hover:text-red-400 disabled:opacity-50"
              >
                {uploadState === "removing" ? "移除中…" : "移除图片"}
              </button>
            ) : null}
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-stone-600">
            JPG / PNG / WebP / GIF，2MB 以内，会裁成正方形并压缩。
            <br />
            上传的图片会去掉拍摄信息（EXIF），不会带上手机定位。
          </p>
        </div>

        {/* ------------------------------------------------- 生成头像 */}
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] text-stone-400">生成头像</span>
            <span className="text-[11px] text-stone-600">
              {hasImage ? "移除图片后生效" : "同一个种子永远是同一张脸"}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PORTRAIT_STYLES.map((item) => {
              const active = item.key === portrait.style;

              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => patch({ style: item.key as PortraitStyle })}
                  title={`${item.hint} · ${item.license} · ${item.author}`}
                  className={`rounded-md border px-2 py-1 text-[12px] transition ${
                    active
                      ? "border-ember-600 bg-ember-600/15 text-ember-300"
                      : "border-ink-700 text-stone-400 hover:border-ink-600 hover:text-stone-300"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() =>
              patch({ seed: Math.random().toString(36).slice(2, 10) })
            }
            className="mt-2 rounded-md border border-ink-700 px-2.5 py-1 text-[12px] text-stone-400 transition hover:border-ember-600 hover:text-ember-400"
          >
            换一张脸
          </button>

          {needsAttribution(portrait.style) ? (
            <p className="mt-2 text-[11px] leading-relaxed text-stone-600">
              「{style?.label}」画风由 {style?.author} 创作，以 CC BY 4.0 授权，
              商用需署名。
            </p>
          ) : null}
        </div>

        {/* ----------------------------------------------------- 边框 */}
        <div>
          <span className="text-[12px] text-stone-400">边框</span>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PORTRAIT_FRAMES.map((item) => {
              const active = item.key === portrait.frame;

              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => patch({ frame: item.key as PortraitFrame })}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition ${
                    active
                      ? "border-ember-600 bg-ember-600/15 text-ember-300"
                      : "border-ink-700 text-stone-400 hover:border-ink-600 hover:text-stone-300"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{
                      background: item.ring,
                      boxShadow: `0 0 0 1px ${item.outer}`,
                    }}
                    aria-hidden
                  />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ----------------------------------------------------- 保存 */}
        <div className="flex flex-wrap items-center gap-3 pt-0.5">
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="rounded-lg bg-ember-500 px-3.5 py-1.5 text-[13px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存形象"}
          </button>

          {notice ? (
            <span className="text-[12px] text-emerald-400">{notice}</span>
          ) : null}
          {error ? <span className="text-[12px] text-red-400">{error}</span> : null}
        </div>

        <p className="text-[11px] leading-relaxed text-stone-600">
          形象随时能改，进行中的游戏也能改 —— 换张脸不影响任何数值。
          请只上传你有权使用的图片。
        </p>
      </div>
    </div>
  );
}
