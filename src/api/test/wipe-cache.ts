import { isValidSuiAddress } from "@mysten/sui/utils";
import { wipeCache } from "../../services/rehydration";
import type { HandlerResult } from "../chat";

/**
 * POST /api/v1/test/wipe-cache - demo-only route (RULE.md section 4).
 * Deletes the user's Postgres cache so the next chat message visibly
 * rebuilds state from Walrus Memory Mainnet. Never exposed outside the
 * demo environment; Walrus data is not touched.
 */
export async function postWipeCache(body: {
  user_id?: string;
}): Promise<HandlerResult> {
  const userId = body.user_id ?? "";
  if (!isValidSuiAddress(userId)) {
    return {
      status: 400,
      body: { status: "error", response: "user_id must be a valid Sui wallet address." },
    };
  }
  const { deletedFacts } = await wipeCache(userId);
  return {
    status: 200,
    body: {
      status: "success",
      response: `Cache wiped: ${deletedFacts} cached facts deleted. The next chat will rehydrate from Walrus.`,
      deleted_facts: deletedFacts,
      timestamp: new Date().toISOString(),
    },
  };
}
