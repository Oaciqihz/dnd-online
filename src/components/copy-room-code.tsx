"use client";

import { useState } from "react";

export function CopyRoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 非 https / 剪贴板被拒时，让用户手动选中复制，不弹报错
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-lg border border-ink-700 px-2.5 py-1 text-[12px] text-stone-400 transition hover:border-ember-600 hover:text-ember-400"
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}
