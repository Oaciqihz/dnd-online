import Link from "next/link";
import { redirect } from "next/navigation";
import { GuestForm } from "@/components/guest-form";
import { AuthShell } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";

export default async function GuestPage() {
  if (await getCurrentUser()) redirect("/lobby");

  return (
    <AuthShell
      title="以游客身份进入"
      description="起个名字就能进，不需要邮箱和密码。游客身份存在当前浏览器里，换设备需要重新进入。"
      footer={
        <>
          想长期保存角色？
          <Link
            href="/register"
            className="ml-1 text-ember-400 transition hover:underline"
          >
            注册一个账号
          </Link>
        </>
      }
    >
      <GuestForm />
    </AuthShell>
  );
}
