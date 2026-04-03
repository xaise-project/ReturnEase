import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  icon?: string;
  color?: string;
  trend?: { value: number; direction: "up" | "down" };
  onClick?: () => void;
  badge?: ReactNode;
}

export function StatCard({
  label,
  value,
  subtitle,
  icon,
  color = "#6366F1",
  trend,
  onClick,
  badge,
}: StatCardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background: `linear-gradient(135deg, ${color}06 0%, ${color}12 100%)`,
        borderRadius: 14,
        padding: "20px 22px",
        borderLeft: `4px solid ${color}`,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        cursor: onClick ? "pointer" : "default",
        transition: "box-shadow 0.2s, transform 0.15s",
        position: "relative" as const,
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.1)";
          e.currentTarget.style.transform = "translateY(-1px)";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      {/* Decorative circle */}
      <div
        style={{
          position: "absolute",
          top: -20,
          right: -20,
          width: 80,
          height: 80,
          borderRadius: "50%",
          background: `${color}08`,
        }}
      />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: "#6B7280", letterSpacing: "0.02em", marginBottom: 6 }}>
            {label}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 28, fontWeight: 700, color: "#111827", lineHeight: 1.1 }}>
              {value}
            </span>
            {badge}
          </div>
          {(subtitle || trend) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              {trend && (
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: trend.direction === "up" ? "#10B981" : "#EF4444",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  {trend.direction === "up" ? "▲" : "▼"} {Math.abs(trend.value).toFixed(1)}%
                </span>
              )}
              {subtitle && (
                <span style={{ fontSize: 12, color: "#9CA3AF" }}>{subtitle}</span>
              )}
            </div>
          )}
        </div>
        {icon && (
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              background: `${color}15`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
