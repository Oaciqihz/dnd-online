import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/register-form";
import { AuthShell } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/lobby");

  return (
    <AuthShell
      title="创建账号"
      description="注册后角色和房间可以长期保存，换设备也能接着玩。"
      footer={
        <>
          已经有账号了？
          <Link
            href="/login"
            className="ml-1 text-ember-400 transition hover:underline"
          >
            去登录
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthShell>
  );
}
