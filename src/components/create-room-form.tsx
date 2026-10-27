"use client";

import { useActionState } from "react";
import { createRoomAction } from "@/app/actions/rooms";
import { initialRoomState } from "@/lib/form-state";
import { Field, FormError, primaryButton } from "./ui";

export function CreateRoomForm() {
  const [state, formAction, pending] = useActionState(
    createRoomAction,
    initialRoomState,
  );

  return (
    <form action={formAction} className="space-y-3">
      <Field
        label="房间名"
        name="name"
        placeholder="比如：地精洞穴之夜"
        hint="创建后你会成为这个房间的 DM"
      />

      <FormError message={state.error} />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "创建中…" : "创建房间"}
      </button>
    </form>
  );
}
