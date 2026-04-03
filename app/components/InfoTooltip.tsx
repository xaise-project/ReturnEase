import { useState } from "react";
import { Tooltip, Collapsible } from "@shopify/polaris";

interface InfoTooltipProps {
  content: string;
  mode?: "hover" | "expandable";
  label?: string;
}

export function InfoTooltip({ content, mode = "hover", label }: InfoTooltipProps) {
  const [expanded, setExpanded] = useState(false);

  if (mode === "hover") {
    return (
      <Tooltip content={content}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#E5E7EB",
            color: "#6B7280",
            fontSize: 10,
            fontWeight: 700,
            cursor: "help",
            verticalAlign: "middle",
            marginLeft: 6,
          }}
        >
          ?
        </span>
      </Tooltip>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          fontSize: 12,
          color: "#6366F1",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span style={{ fontSize: 10 }}>{expanded ? "▼" : "▶"}</span>
        {label || "Daha fazla bilgi"}
      </button>
      <Collapsible open={expanded} id="info-expandable">
        <div
          style={{
            marginTop: 6,
            padding: "10px 14px",
            background: "#F5F3FF",
            borderRadius: 8,
            fontSize: 12,
            color: "#4B5563",
            lineHeight: 1.6,
            borderLeft: "3px solid #6366F1",
          }}
        >
          {content}
        </div>
      </Collapsible>
    </div>
  );
}
