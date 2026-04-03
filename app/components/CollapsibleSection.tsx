import { useState, type ReactNode } from "react";
import { Collapsible } from "@shopify/polaris";

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = false,
  badge,
  action,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          cursor: "pointer",
          userSelect: "none",
          borderBottom: open ? "1px solid #F3F4F6" : "none",
          transition: "border-bottom 0.15s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 12,
              color: "#9CA3AF",
              transition: "transform 0.2s",
              display: "inline-block",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▶
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{title}</span>
          {badge}
        </div>
        {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
      </div>
      <Collapsible open={open} id={`collapsible-${title.replace(/\s/g, "-")}`}>
        <div style={{ padding: "16px 20px" }}>{children}</div>
      </Collapsible>
    </div>
  );
}
