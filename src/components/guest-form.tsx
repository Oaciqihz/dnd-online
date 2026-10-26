"use client";

import { useActionState } from "react";
import { guestAction } from "@/app/actions/auth";
import { initialAuthState } from "@/lib/form-state";
import { Field, FormError, primaryButton } from "./ui";

export function GuestForm() {
  const [state, formAction, pending] = useActionState(
    guestAction,
    initialAuthState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="你的昵称"
        name="nickname"
        autoComplete="nickname"
        placeholder="朋友在房间里看到的名字"
        hint="游客身份只在当前浏览器有效，换设备需要重新进入"
      />

      <FormError message={state.error} />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "进入中…" : "进入"}
      </button>
    </form>
  );
}
