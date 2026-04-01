/**
 * Automated Resolution Rules engine.
 *
 * Rules are evaluated top-to-bottom; first match wins.
 * Each rule has a condition (what to check) and a resolution (what to apply).
 *
 * Supported conditions:
 *  - ORDER_AMOUNT_GTE   : total return value >= value
 *  - ORDER_AMOUNT_LTE   : total return value <= value
 *  - CUSTOMER_TAG       : customer has tag matching value
 *  - REASON             : return reason contains value (case-insensitive)
 *  - RETURN_COUNT_GTE   : customer's lifetime return count >= value
 *
 * Supported resolutions:
 *  - STORE_CREDIT, EXCHANGE, REFUND, KEEP_IT
 */

export type RuleCondition =
  | "ORDER_AMOUNT_GTE"
  | "ORDER_AMOUNT_LTE"
  | "CUSTOMER_TAG"
  | "REASON"
  | "RETURN_COUNT_GTE";

export type RuleResolution = "STORE_CREDIT" | "EXCHANGE" | "REFUND" | "KEEP_IT";

export interface ResolutionRule {
  id: string;
  condition: RuleCondition;
  value: string;
  resolution: RuleResolution;
  label?: string; // human-readable description, optional
}

export interface RuleEvalContext {
  orderAmount: number;
  customerTags: string[];     // ["VIP", "wholesale", ...]
  reason: string;             // raw reason string from form
  customerReturnCount: number;
}

export function parseResolutionRules(json: string | null | undefined): ResolutionRule[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r) => r && typeof r.id === "string" && typeof r.condition === "string" && typeof r.value === "string" && typeof r.resolution === "string",
    );
  } catch {
    return [];
  }
}

export function evaluateRules(
  rules: ResolutionRule[],
  ctx: RuleEvalContext,
): RuleResolution | null {
  for (const rule of rules) {
    if (matchesRule(rule, ctx)) {
      return rule.resolution;
    }
  }
  return null;
}

function matchesRule(rule: ResolutionRule, ctx: RuleEvalContext): boolean {
  const v = rule.value.trim();
  switch (rule.condition) {
    case "ORDER_AMOUNT_GTE":
      return ctx.orderAmount >= parseFloat(v);
    case "ORDER_AMOUNT_LTE":
      return ctx.orderAmount <= parseFloat(v);
    case "CUSTOMER_TAG":
      return ctx.customerTags.some((tag) => tag.toLowerCase() === v.toLowerCase());
    case "REASON":
      return ctx.reason.toLowerCase().includes(v.toLowerCase());
    case "RETURN_COUNT_GTE":
      return ctx.customerReturnCount >= parseInt(v, 10);
    default:
      return false;
  }
}
