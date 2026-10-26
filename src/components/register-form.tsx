"use client";

import { useActionState } from "react";
import { registerAction } from "@/app/actions/auth";
import { initialAuthState } from "@/lib/form-state";
import { Field, FormError, primaryButton } from "./ui";

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(
    registerAction,
    initialAuthState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="用户名"
        name="username"
        autoComplete="username"
        placeholder="3–16 位，中文 / 字母 / 数字 / 下划线"
        hint="登录时使用，注册后不可修改"
      />
      <Field
        label="密码"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="至少 8 位"
      />
      <Field
        label="确认密码"
        name="confirm"
        type="password"
        autoComplete="new-password"
        placeholder="再输入一次"
      />

      <FormError message={state.error} />

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "创建中…" : "创建账号"}
      </button>
    </form>
  );
}
