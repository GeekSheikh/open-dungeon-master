"use client";

import { LoadFailed } from "@/app/campaigns/[campaignId]/PanelKit";
import { readLoad, useLoadStatus } from "@/lib/load-state";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ui } from "@/lib/ui";

// The receiver addresses player agents' webhooks may reach
// (docs/player-webhooks.md). Saved on each change and live at once: the
// first address turns delivery on with no restart. Addresses from the
// ODM_PLAYER_WEBHOOK_ORIGINS environment variable are listed too, read-only.
export function AdminPlayerAgentsSection() {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [envOrigins, setEnvOrigins] = useState<string[]>([]);
  const { loadError, settle } = useLoadStatus();
  const [reloads, setReloads] = useState(0);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    readLoad<{ origins?: string[]; envOrigins?: string[] }>(fetch("/api/admin/player-webhooks"), "The receiver addresses").then((outcome) => {
      settle(outcome);
      if (outcome.payload) {
        setOrigins(outcome.payload.origins ?? []);
        setEnvOrigins(outcome.payload.envOrigins ?? []);
      }
    });
  }, [reloads, settle]);

  async function save(next: string[]) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/player-webhooks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origins: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? "Could not save the receiver addresses.");
        return false;
      }
      setOrigins(data.origins ?? next);
      setEnvOrigins(data.envOrigins ?? envOrigins);
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (await save([...(origins ?? []), address.trim()])) setAddress("");
  }

  if (origins === null) {
    return loadError ? (
      <LoadFailed error={loadError} onRetry={() => setReloads((current) => current + 1)} />
    ) : (
      <div className="skeleton-block h-12 rounded-xl" aria-label="Loading receiver addresses" />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-400">
        A player can seat their own agent at a table and have it woken on its turn by a small receiver on their computer
        (Settings &gt; Connected agents). This server sends only to the HTTPS addresses listed here. Add one only for a
        receiver you trust: it lets the server make requests to that host.
      </p>
      {origins.length === 0 && envOrigins.length === 0 ? (
        <p className="text-xs text-stone-500">None yet, so player agents are not woken.</p>
      ) : (
        <ul className="space-y-2">
          {envOrigins.map((origin) => (
            <li key={`env-${origin}`} className="plate-row">
              <code className="min-w-0 flex-1 truncate text-sm text-stone-200">{origin}</code>
              <span className="text-[11px] text-stone-500">from ODM_PLAYER_WEBHOOK_ORIGINS</span>
            </li>
          ))}
          {origins.map((origin) => (
            <li key={origin} className="plate-row">
              <code className="min-w-0 flex-1 truncate text-sm text-stone-200">{origin}</code>
              <button
                type="button"
                className={ui.btnSmall}
                disabled={busy}
                onClick={() => void save(origins.filter((entry) => entry !== origin))}
              >
                <Trash2 className="size-3.5" /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1">
          <span className="mb-1 block text-xs font-medium text-stone-400">Receiver address</span>
          <input
            className={ui.input}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && address.trim() && !busy) void add();
            }}
            placeholder="https://my-pc.example.ts.net:8443"
          />
        </label>
        <button type="button" className={ui.btnSecondary} disabled={busy || !address.trim()} onClick={() => void add()} aria-busy={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Allow
        </button>
      </div>
      {error ? (
        <p role="alert" className="motion-shake text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
