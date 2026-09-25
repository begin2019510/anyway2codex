import { queryLogs, getLogStats, getLogById, queryConversations, queryConversationLogs, getConversationCount } from "../../db/logs.js";
import type { ChatLog } from "../../db/logs.js";

export function handleLogRoutes(params?: { limit?: number; offset?: number }) {
  const limit = Math.min(params?.limit ?? 200, 500);
  const offset = params?.offset ?? 0;
  return { logs: queryLogs(limit, undefined, offset), stats: getLogStats() };
}

export function handleLogDetail(id: number) {
  const log = getLogById(id);
  if (!log) return { error: "not found" };
  return log;
}

export function handleConversationList(params?: { limit?: number; offset?: number }) {
  const limit = Math.min(params?.limit ?? 50, 200);
  const offset = params?.offset ?? 0;
  return { conversations: queryConversations(limit, offset), total: getConversationCount() };
}

export function handleConversationDetail(threadId: string) {
  const logs = queryConversationLogs(threadId);
  if (!logs.length) return { error: "not found", thread_id: threadId };
  return { thread_id: threadId, logs };
}
