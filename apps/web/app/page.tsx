"use client";

import { useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { Dashboard } from "@/components/Dashboard";
import { Header, type ServerStatus } from "@/components/Header";
import { useAgent } from "@/lib/use-agent";
import type { PromptInfo, ToolInfo } from "@/lib/types";

interface ToolsResponse {
  server?: { name: string; version: string };
  serverUrl: string;
  model: string;
  tools: ToolInfo[];
  prompts: PromptInfo[];
  resources: string[];
  error?: string;
}

export default function Page() {
  const agent = useAgent();
  const [server, setServer] = useState<ServerStatus>({ state: "connecting" });
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [mobilePane, setMobilePane] = useState<"chat" | "portfolio">("chat");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools")
      .then(async (res) => {
        const data = (await res.json()) as ToolsResponse;
        if (cancelled) return;
        if (!res.ok || data.error) {
          setServer({ state: "error", message: data.error ?? `HTTP ${res.status}` });
          return;
        }
        setTools(data.tools);
        setPrompts(data.prompts);
        setServer({
          state: "connected",
          serverName: data.server?.name ?? "mcp",
          serverVersion: data.server?.version ?? "",
          serverUrl: data.serverUrl,
          model: data.model,
          toolCount: data.tools.length,
          resourceCount: data.resources.length
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setServer({ state: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <Header status={server} mobilePane={mobilePane} onMobilePane={setMobilePane} />
      <main className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 gap-0 overflow-hidden px-4 pb-4 lg:grid-cols-[minmax(0,7fr)_minmax(360px,5fr)] lg:gap-4 lg:px-6">
        <section className={`${mobilePane === "chat" ? "flex" : "hidden"} min-h-0 flex-col lg:flex`} aria-label="Conversation">
          <Chat agent={agent} tools={tools} prompts={prompts} serverState={server.state} />
        </section>
        <aside className={`${mobilePane === "portfolio" ? "flex" : "hidden"} min-h-0 flex-col lg:flex`} aria-label="Portfolio">
          <Dashboard refreshKey={agent.runCount} />
        </aside>
      </main>
    </div>
  );
}
