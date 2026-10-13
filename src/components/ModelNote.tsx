"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import type { ModelRole, ModelVerdict } from "@/lib/model-registry/catalog-logic";

// One quiet line under a campaign's model field: what the model catalog
// says of the model named (GET /api/models), and a warning when it is
// deprecated or cannot do the role's work. Catalog only, so it costs no
// backend call and needs no key; the admin's pickers do the live listing.
export function ModelNote({ role, baseUrl, model }: { role: ModelRole; baseUrl: string; model: string }) {
  // The answer is kept with the question it answers, so a changed model
  // shows nothing (not the old model's note) until its own answer lands.
  const [answer, setAnswer] = useState<{ key: string; verdict: ModelVerdict | null } | null>(null);
  const name = model.trim();
  const key = `${role}|${baseUrl}|${name}`;

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    const params = new URLSearchParams({ role, model: name, baseUrl });
    void fetch(`/api/models?${params}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { verdict?: ModelVerdict } | null) => {
        if (!cancelled) setAnswer({ key, verdict: data?.verdict ?? null });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ key, verdict: null });
      });
    return () => {
      cancelled = true;
    };
  }, [role, baseUrl, name, key]);

  const verdict = answer?.key === key ? answer.verdict : null;
  if (!verdict) return null;
  const tone = verdict.fit === "unfit" ? "text-red-400" : verdict.fit === "warn" ? "text-amber-300" : "text-stone-500";
  return <p className={cn("text-[11px] leading-4", tone)}>{[...verdict.warnings, verdict.summary].join(" ")}</p>;
}
