import Link from "next/link";

export const inputClass =
  "w-full rounded-lg border border-ink-700 bg-ink-900/70 px-3.5 py-2.5 text-[15px] text-parchment placeholder:text-stone-600 outline-none transition focus:border-ember-500 focus:ring-2 focus:ring-ember-500/20";

export const labelClass = "mb-1.5 block text-[13px] font-medium text-stone-400";

export const primaryButton =
  "w-full rounded-lg bg-ember-500 px-4 py-2.5 text-[15px] font-medium text-ink-950 transition hover:bg-ember-400 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButton =
  "flex w-full items-center justify-center rounded-lg border border-ink-700 px-4 py-2.5 text-[15px] font-medium text-parchment transition hover:border-ember-600 hover:text-ember-400";

export function Field({
  label,
  name,
  type = "text",
  placeholder,
  autoComplete,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={inputClass}
      />
      {hint ? (
        <span className="mt-1.5 block text-[12px] text-stone-600">{hint}</span>
      ) : null}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <p
      role="alert"
      className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[13px] leading-relaxed text-red-300"
    >
      {message}
    </p>
  );
}

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16">
      <Link
        href="/"
        className="mb-9 inline-flex w-fit items-center gap-1.5 text-[13px] text-stone-500 transition hover:text-ember-400"
      >
        <span aria-hidden>←</span> 返回
      </Link>

      <h1 className="font-serif text-[28px] leading-tight text-parchment">
        {title}
      </h1>

      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-stone-400">
          {description}
        </p>
      ) : null}

      <div className="mt-8">{children}</div>

      {footer ? (
        <div className="mt-7 text-[13px] text-stone-500">{footer}</div>
      ) : null}
    </main>
  );
}
