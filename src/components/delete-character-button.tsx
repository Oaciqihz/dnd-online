"use client";

import { useState } from "react";
import { deleteCharacterAction } from "@/app/actions/characters";

/**
 * 删除角色卡。
 *
 * 和踢人用同一套两段式确认：第一次点变成「确认删除」，4 秒内再点才真的删。
 * 删除是不可逆的操作，多一次点击比事后道歉便宜得多。
 */
export function DeleteCharacterButton({ id }: { id: string }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => {
          setArmed(true);
          window.setTimeout(() => setArmed(false), 4000);
        }}
        className="text-[13px] text-stone-600 transition hover:text-red-400"
      >
        删除这张角色卡
      </button>
    );
  }

  return (
    <form action={deleteCharacterAction} className="flex items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="rounded-lg border border-red-900 px-3 py-1.5 text-[13px] text-red-400 transition hover:bg-red-950/40"
      >
        确认删除
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-[13px] text-stone-500 transition hover:text-parchment"
      >
        取消
      </button>
    </form>
  );
}
