/** Private protocol between this extension and its Langium language server. */
export const GET_SHOW_PLANS = 'clinical-dsl/getShowPlans';
export const SHOW_PLANS_READY = 'clinical-dsl/showPlansReady';

export interface SourcePosition {
    line: number;
    character: number;
}

export interface ShowPlanItem {
    range: { start: SourcePosition; end: SourcePosition };
    startOffset: number;
    endOffset: number;
    sourceText: string;
    planName: string;
    /** Formatted, plain JSON data; never a raw AST. */
    json?: string;
    error?: string;
}

export interface ShowPlansRequest {
    uri: string;
    version: number;
}

export interface ShowPlansResponse {
    uri: string;
    version: number;
    blockCommentsSupported: boolean;
    items: ShowPlanItem[];
}
