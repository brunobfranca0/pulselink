import { useEffect, type ReactNode } from "react";
import { IconKeyboard, IconMouse, IconX } from "./Icons";

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ children, title }: { tone?: "ok" | "warn" | "bad"; live?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className="chip" title={title}>
      {children}
    </span>
  );
}

/** Small colored dot + label. Color is the only signal, so it is always paired with text. */
export function Status({ tone, children }: { tone?: "on" | "idle" | "off"; children: ReactNode }) {
  return <span className={`status ${tone ?? ""}`}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" role="progressbar" aria-label="Carregando" />;
}

export function Avatar({ name, size }: { name: string; size?: "sm" | "lg" }) {
  const initials =
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return <span className={`avatar ${size ?? ""}`}>{initials}</span>;
}


export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div className="spacer">
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label="Fechar">
            <IconX size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export type Perms = { keyboard: boolean; mouse: boolean };

/** Keyboard / mouse control toggles. Gamepad is not offered: there is no virtual-controller driver yet. */
export function PermissionToggles({
  perms,
  onToggle,
  disabled,
}: {
  perms: Perms;
  onToggle?: (key: keyof Perms) => void;
  disabled?: boolean;
}) {
  const items: { key: keyof Perms; label: string; icon: ReactNode }[] = [
    { key: "keyboard", label: "Teclado", icon: <IconKeyboard size={16} /> },
    { key: "mouse", label: "Mouse", icon: <IconMouse size={16} /> },
  ];
  return (
    <div className="perms">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`perm ${perms[it.key] ? "on" : ""}`}
          disabled={disabled || !onToggle}
          onClick={() => onToggle?.(it.key)}
          aria-pressed={perms[it.key]}
          title={`${it.label}: ${perms[it.key] ? "permitido" : "bloqueado"}`}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="kbd">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}
