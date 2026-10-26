"use client";

import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";
import { initialAuthState } from "@/lib/form-state";
import { Field, FormError, primaryButton } from "./ui";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(
    loginAction,
    initialAuthState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="用户名"
        name="username"
        autoComplete="username"
        placeholder="输入你的用户名"
      />
      <Field
        label="密码"
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="输入密码"
      />

      <FormError message={state.error} />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
