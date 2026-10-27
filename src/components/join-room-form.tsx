"use client";

import { useActionState } from "react";
import { joinRoomAction } from "@/app/actions/rooms";
import { initialRoomState } from "@/lib/form-state";
import { FormError, inputClass, labelClass, primaryButton } from "./ui";

export function JoinRoomForm() {
  const [state, formAction, pending] = useActionState(
    joinRoomAction,
    initialRoomState,
  );

  return (
    <form action={formAction} className="space-y-3">
      <label className="block">
        <span className={labelClass}>房间码</span>
        <input
          name="code"
          placeholder="ABC234"
          maxLength={6}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className={`${inputClass} text-center font-mono text-[18px] tracking-[0.35em] uppercase`}
        />
        <span className="mt-1.5 block text-[12px] text-stone-600">
          向 DM 要 6 位房间码，大小写都行
        </span>
      </label>

      <FormError message={state.error} />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "加入中…" : "加入房间"}
      </button>
    </form>
  );
}
