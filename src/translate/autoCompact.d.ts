export function estimateMessageTokens(msg: any): number;
export function estimateTokens(messages: any[]): number;
export function planChatCompaction(messages: any[], opts: { atTokens: number }): any;
export function renderMessagesAsText(messages: any[]): string;
export function summarizeMiddle(middle: any[], model: string, callChat: any, opts?: any): Promise<string>;
export function maybeCompactChat(chat: any, ctx: { atTokens: number; callChat: any }): Promise<any>;
export function summaryCacheKey(model: string, renderedMiddle: string): string;
export function _clearSummaryCache(): void;
