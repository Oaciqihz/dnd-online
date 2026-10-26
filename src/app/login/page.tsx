import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { AuthShell } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/lobby");

  return (
    <AuthShell
      title="登录"
      description="用你注册时的用户名和密码进入。"
      footer={
        <>
          还没有账号？
          <Link
            href="/register"
            className="ml-1 text-ember-400 transition hover:underline"
          >
            注册一个
          </Link>
          <span className="mx-2 text-stone-700">·</span>
          <Link
            href="/guest"
            className="text-stone-400 transition hover:text-ember-400"
          >
            先以游客身份试试
          </Link>
        </>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
