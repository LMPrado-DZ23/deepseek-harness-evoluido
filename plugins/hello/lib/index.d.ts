/** Isolated Harness Studio PoC plugin over public DeepSeek Harness seams. */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { type KvTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
export declare const name = "studio-hello";
export declare const inject: string[];
export declare const STUDIO_PROVIDER = "studio-fake";
export declare const STUDIO_MODEL = "studio-deterministic";
export declare const STUDIO_TENANT = "tenant-poc-01";
export declare const STUDIO_LOGICAL_DOMAIN = "studio.hello";
export declare const STUDIO_PHYSICAL_DOMAIN = "studio_hello";
export declare const STUDIO_RECORD_KEY: StudioRecordKey;
export declare const STUDIO_CREATED_AT = "2026-09-01T00:00:00.000Z";
declare const studioRecordKeyBrand: unique symbol;
export type StudioRecordKey = string & {
    readonly [studioRecordKeyBrand]: true;
};
export declare const studioHelloRecord: z.ZodObject<{
    tenant_id: z.ZodString;
    created_at: z.ZodISODateTime;
    note: z.ZodString;
}, z.core.$strict>;
export type StudioHelloRecord = z.infer<typeof studioHelloRecord>;
export declare const studioHelloDomainSpec: {
    name: string;
    version: number;
    tables: {
        records: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<StudioRecordKey, {
            tenant_id: string;
            created_at: string;
            note: string;
        }>;
    };
};
export interface StudioHelloRuntime {
    record(key?: StudioRecordKey): StudioHelloRecord | undefined;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        studioHello: StudioHelloRuntime;
    }
}
/** Deterministic, keyless provider used only by this PoC. */
export declare class StudioFakeAdapter extends LlmAdapter {
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export declare function createStudioEchoTool(table: KvTable<StudioRecordKey, StudioHelloRecord>): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Mount the tool, fake LLM route, and owned typed storage domain. */
export declare function apply(ctx: Context): Promise<void>;
export {};
