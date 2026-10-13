"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Field } from "@/app/admin/AdminSettingsFields";
import { Select, type SelectOption } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import type { ModelChoices, RegistryModel, RegistryProvider } from "@/lib/model-registry/registry";
import type { ModelRole } from "@/lib/model-registry/catalog-logic";
import { ui } from "@/lib/ui";

// A model field that lists what the backend serves (POST /api/admin/models):
// the server's own list, each row with the catalog's word on it, and the
// model already chosen kept on the list even when the server no longer
// names it. A model the server does not list can still be typed: the list
// is help, not a gate. The chosen model is never changed by a listing.

const TYPE_OWN = "\u0000type";
const BLANK = "\u0000blank";

export type ModelChoiceProps = {
  label: string;
  hint?: string;
  role: ModelRole;
  provider: RegistryProvider;
  baseUrl?: string;
  // A freshly typed key, for this listing only; "" sends the saved key for
  // the saved host.
  apiKey?: string;
  harnessId?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  // Blank means "off" (the utility model).
  blankLabel?: string;
};

export function modelTone(model: RegistryModel | undefined): string {
  if (!model) return "text-stone-500";
  if (model.verdict.fit === "unfit") return "text-red-400";
  if (model.verdict.fit === "warn") return "text-amber-300";
  return "text-stone-500";
}

// The one line under the field: what is known of the chosen model.
export function modelLine(model: RegistryModel | undefined): string {
  if (!model) return "";
  const parts = [...model.verdict.warnings, model.verdict.summary];
  if (model.tested) {
    parts.push(
      model.tested.ok
        ? `Tested here ${model.tested.at.slice(0, 10)}: runs the storyteller loop.`
        : `Tested here ${model.tested.at.slice(0, 10)}: failed (${[
            !model.tested.stages.streaming && "no stream",
            !model.tested.stages.toolCall && "no tool call",
            !model.tested.stages.toolContinuation && "no continuation",
          ]
            .filter(Boolean)
            .join(", ")}).`,
    );
  }
  return parts.join(" ");
}

export function ModelChoiceField(props: ModelChoiceProps) {
  const { label, hint, role, provider, baseUrl = "", apiKey = "", harnessId, value, onChange, placeholder, blankLabel } = props;
  const [choices, setChoices] = useState<ModelChoices | null>(null);
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(false);
  // The models that cannot do the role's work are kept off the list; one
  // click shows them, named with why.
  const [showUnfit, setShowUnfit] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = (latest.current += 1);
    setLoading(true);
    try {
      const response = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", role, provider, baseUrl, apiKey, model: value, harnessId }),
      });
      const data = (await response.json().catch(() => null)) as ModelChoices | null;
      if (ticket === latest.current) {
        setChoices(data && Array.isArray(data.models) ? data : null);
      }
    } catch {
      if (ticket === latest.current) setChoices(null);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
    // The chosen model is sent so it is on the list; it never triggers a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, provider, baseUrl, apiKey, harnessId]);

  // Listed on arrival and when the address changes, a moment after typing
  // stops. A typed key is not sent until "Look again": a half-typed key
  // should not be tried against the server.
  useEffect(() => {
    const timer = setTimeout(() => void load(), choices ? 600 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, provider, baseUrl, harnessId]);

  const all = choices?.models ?? [];
  const chosen = all.find((model) => model.id === value);
  const unfit = all.filter((model) => model.verdict.fit === "unfit" && model.id !== value);
  const models = showUnfit ? all : all.filter((model) => model.verdict.fit !== "unfit" || model.id === value);
  const listable = models.length > 0 && !typing;

  const options: SelectOption<string>[] = [
    ...(blankLabel ? [{ value: BLANK, label: blankLabel }] : []),
    ...models.map((model) => ({
      value: model.id,
      label: `${model.label}${model.listed === false ? " (not listed)" : ""}${model.verdict.fit === "unfit" ? " (unfit)" : ""}`,
      hint: [model.note, model.verdict.summary].filter(Boolean).join(" · "),
    })),
    { value: TYPE_OWN, label: "Type a model id…" },
  ];

  return (
    <Field label={label} hint={hint} group>
      <div className="flex items-start gap-2">
        {listable ? (
          <Select
            value={value || (blankLabel ? BLANK : "")}
            onChange={(next) => {
              if (next === TYPE_OWN) {
                setTyping(true);
                return;
              }
              onChange(next === BLANK ? "" : next);
            }}
            options={options}
            label={label}
            className="w-full"
          />
        ) : (
          <input
            className={ui.input}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => {
              if (models.length) setTyping(false);
            }}
            placeholder={placeholder}
            aria-label={label}
          />
        )}
        <button
          type="button"
          onClick={() => {
            setTyping(false);
            void load();
          }}
          disabled={loading}
          aria-busy={loading}
          title="List the backend's models again"
          className={cn(ui.btnSmall, "shrink-0")}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Look again
        </button>
      </div>
      {choices && choices.reachable === false ? (
        <p className="mt-1 text-[11px] leading-4 text-amber-300">{choices.error || "The backend did not answer."}</p>
      ) : null}
      {chosen ? (
        <p className={cn("mt-1 text-[11px] leading-4", modelTone(chosen))}>{modelLine(chosen)}</p>
      ) : value && choices && !loading ? (
        <p className="mt-1 text-[11px] leading-4 text-stone-500">Not in the catalog; ODM will try it as typed.</p>
      ) : null}
      {unfit.length ? (
        <p className="mt-1 text-[11px] leading-4 text-stone-500">
          {unfit.length} {unfit.length === 1 ? "model" : "models"} the backend lists cannot run the {role === "image" ? "painter" : "storyteller"}
          {showUnfit ? "" : " and " + (unfit.length === 1 ? "is" : "are") + " left off the list"}.{" "}
          <button type="button" className="underline hover:text-stone-300" onClick={() => setShowUnfit((on) => !on)}>
            {showUnfit ? "Hide them" : "Show them"}
          </button>
        </p>
      ) : null}
      {choices ? (
        <p className="mt-1 text-[11px] leading-4 text-stone-600">
          {choices.hardware ? `This machine: ${choices.hardware.summary}. ` : ""}
          {choices.reachable === true ? `${all.filter((model) => model.listed).length} listed by the backend. ` : ""}
          Catalog: {choices.catalog.models} models
          {choices.catalog.fetchedAt ? ` as of ${choices.catalog.fetchedAt.slice(0, 10)}` : ""}
          {choices.catalog.source === "snapshot" ? " (bundled copy)" : ""}
          {choices.catalog.error ? `; last refresh failed: ${choices.catalog.error}` : ""}.
        </p>
      ) : null}
    </Field>
  );
}
