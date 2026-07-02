export interface ApprovalRequiredPayload {
  toolCallId: string;
  toolName: string;
  description: string;
  amount: number;
  accounts: string[];
  limit: number;
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
}

// Matches the exact wording thrown by postTransaction() in
// .pi/extensions/bookkeeping/ledger.ts when checkAutoPost() blocks a post.
const AUTO_POST_LIMIT_PATTERN = /exceeds auto-post limit of \$([\d,]+\.\d{2})/;

export function detectAutoPostBlock(
  toolCallId: string,
  toolName: string,
  args: any,
  result: ToolResultLike | undefined,
  isError: boolean
): ApprovalRequiredPayload | null {
  if (!isError) return null;

  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;

  const match = text.match(AUTO_POST_LIMIT_PATTERN);
  if (!match) return null;

  const limit = parseFloat(match[1].replace(/,/g, ""));

  let description = "Transaction";
  let amount = 0;
  let accounts: string[] = [];

  if (toolName === "post_transaction" && Array.isArray(args?.splits)) {
    description = typeof args.description === "string" ? args.description : "Transaction";
    accounts = args.splits
      .map((s: any) => s?.account)
      .filter((a: unknown): a is string => typeof a === "string");
    amount = args.splits
      .filter((s: any) => typeof s?.amount === "number" && s.amount > 0)
      .reduce((sum: number, s: any) => sum + s.amount, 0);
  } else {
    // log_transaction, capture_receipt: {date, amount, account, payee, ...}
    description = typeof args?.payee === "string" ? args.payee : "Transaction";
    accounts = typeof args?.account === "string" ? [args.account] : [];
    amount = Math.abs(typeof args?.amount === "number" ? args.amount : 0);
  }

  return { toolCallId, toolName, description, amount, accounts, limit };
}
