import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import type { ToolConfig } from "../core/tool-schema.js";
import type { AgentToolDefinition, AgentToolResult } from "../infrastructure/agent/host.js";
import { controlledFetch } from "../infrastructure/controlled-fetch.js";

const FetchSchema = Type.Object({ url: Type.String({ minLength: 9, maxLength: 2048 }) });
const SearchSchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) });
const SearchResponseSchema = Type.Object({ web: Type.Optional(Type.Object({ results: Type.Array(Type.Object({
  title: Type.String(), url: Type.String(), description: Type.Optional(Type.String()),
}), { maxItems: 100 }) })) });

function result(value: Record<string, unknown>): AgentToolResult {
  return { content: JSON.stringify(value), details: value };
}

export function createComparisonNetworkTools(input: { attemptRoot: string; config: ToolConfig }): AgentToolDefinition[] {
  return [
    { name: "fetch_url", description: "Fetch a public HTTPS source with bounded redirects and save an attempt-scoped byte snapshot. Current web content is supplemental evidence, not a historical snapshot.",
      parameters: FetchSchema, async execute(params, signal) {
        if (!Value.Check(FetchSchema, params)) return result({ status: "invalid_request" });
        try {
          const fetched = await controlledFetch(params.url, { signal });
          const snapshot = `scratch/network/${fetched.contentHash}.bin`;
          await writeAtomic(join(input.attemptRoot, ...snapshot.split("/")), fetched.bytes);
          const text = /^text\/|^application\/(?:json|xml|[^;]+\+json)/i.test(fetched.mediaType)
            ? new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes).slice(0, 16_000) : undefined;
          return result({ status: "ok", finalUrl: fetched.finalUrl, fetchedAt: fetched.fetchedAt,
            contentHash: fetched.contentHash, mediaType: fetched.mediaType, byteLength: fetched.bytes.byteLength,
            snapshot, redirects: fetched.redirects, ...(text === undefined ? {} : { text }),
            limitation: "Current web snapshot; does not prove historical page state." });
        } catch (error) { return result({ status: "fetch_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
    { name: "search_web", description: "Search using the configured provider. Results are leads; fetch and inspect original sources before using them as evidence.",
      parameters: SearchSchema, async execute(params, signal) {
        if (!Value.Check(SearchSchema, params)) return result({ status: "invalid_request" });
        const search = input.config.search;
        if (!search || !process.env[search.keyEnv]) return result({ status: "unavailable", reason: "Search provider or credential is not configured." });
        try {
          const endpoint = new URL(search.endpoint);
          endpoint.searchParams.set("q", params.query);
          if (endpoint.origin !== "https://api.search.brave.com" || endpoint.pathname !== "/res/v1/web/search") {
            throw new Error("Search provider must use the Brave Search web API endpoint.");
          }
          const fetched = await controlledFetch(endpoint.href, { signal, searchKey: process.env[search.keyEnv]! });
          const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes));
          if (!Value.Check(SearchResponseSchema, parsed)) throw new Error("Search provider response does not match the configured results contract.");
          const results = (parsed.web?.results ?? []).slice(0, 10).map((item) => ({ title: item.title.slice(0, 300),
            url: item.url.slice(0, 2048), ...(item.description ? { snippet: item.description.slice(0, 1000) } : {}) }));
          return result({ status: "ok", fetchedAt: fetched.fetchedAt, query: params.query, results,
            limitation: "Search snippets are unverified leads, not source evidence." });
        } catch (error) { return result({ status: "search_failed", message: error instanceof Error ? error.message : String(error) }); }
      } },
  ];
}
