import * as Y from "yjs";
import { supabase } from "./supabaseClient";

export class SupabaseProvider {
  constructor(doc, roomId, localUser, sessionId) {
    this.doc = doc;
    this.roomId = roomId;
    this.localUser = localUser;
    // sessionId is unique per page load so two tabs in the same browser
    // (which share the same localUser.id from localStorage) are treated as
    // distinct presence entries instead of overwriting each other.
    this.sessionId = sessionId ?? Math.random().toString(36).slice(2, 10);
    this._onUpdate = this._onUpdate.bind(this);
    this._saveTimer = null;
    this._lastSeenId = 0;
    this.presenceCallback = null;
    this.statusCallback = null;
    this.destroyed = false;

    // ── Presence + direct Y.js broadcast channel ──────────────────────────────
    this.channel = supabase.channel(roomId, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.sessionId },
      },
    });

    // Fast-path: apply updates broadcast directly by active peers.
    // Y.js ignores duplicate updates (CRDT), so applying the same update
    // from both this path and the DB fetch is safe.
    this.channel.on("broadcast", { event: "y-update" }, ({ payload }) => {
      if (this.destroyed) return;
      try {
        const update = Uint8Array.from(Object.values(payload.update));
        Y.applyUpdate(doc, update, "remote");
      } catch { /* malformed — ignore */ }
    });

    // Presence
    this.channel.on("presence", { event: "sync" }, () => {
      if (!this.destroyed) this.presenceCallback?.(this._presencePeers());
    });
    this.channel.on("presence", { event: "join" }, () => {
      if (!this.destroyed) this.presenceCallback?.(this._presencePeers());
    });
    this.channel.on("presence", { event: "leave" }, () => {
      if (!this.destroyed) this.presenceCallback?.(this._presencePeers());
    });

    this.channel.subscribe(async (status) => {
      if (this.destroyed) return;
      if (status === "SUBSCRIBED") {
        await this.channel.track({ ...localUser, sessionId: this.sessionId, cursor: 0, variantId: null });
        this.statusCallback?.("connected");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        this.statusCallback?.("error — reconnecting");
      } else if (status === "CLOSED") {
        this.statusCallback?.("disconnected");
      }
    });

    // ── postgres_changes subscription ─────────────────────────────────────────
    // Supabase Realtime pushes INSERT events from doc_updates directly.
    // The full row arrives in the payload so no extra fetch is needed.
    // client_id lets us skip rows we inserted ourselves.
    this.updateChannel = supabase
      .channel(`doc-pg-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "doc_updates",
          filter: `doc_id=eq.${roomId}`,
        },
        (payload) => {
          if (this.destroyed) return;
          if (payload.new.client_id === localUser.id) return;
          try {
            const update = Uint8Array.from(payload.new.y_update);
            Y.applyUpdate(this.doc, update, "remote");
            if (payload.new.id > this._lastSeenId) this._lastSeenId = payload.new.id;
          } catch { /* malformed — ignore */ }
        }
      )
      .subscribe();

    doc.on("update", this._onUpdate);
  }

  _onUpdate(update, origin) {
    if (this.destroyed || origin === "remote") return;

    // Fast path: broadcast directly to connected peers
    this.channel.send({
      type: "broadcast",
      event: "y-update",
      payload: { update: Array.from(update) },
    });

    // Durable path: persist to DB (triggers broadcast to peers not yet connected)
    supabase
      .from("doc_updates")
      .insert({
        doc_id: this.roomId,
        client_id: this.localUser.id,
        y_update: Array.from(update),
      })
      .then(({ error }) => {
        if (error) console.warn("[SupabaseProvider] insert failed:", error.message);
      });
  }

  sendCursor(offset, variantId) {
    if (this.destroyed) return;
    this.channel.track({ ...this.localUser, sessionId: this.sessionId, cursor: offset, variantId });
  }

  _presencePeers() {
    const state = this.channel.presenceState();
    return Object.values(state)
      .flat()
      .filter((p) => p.sessionId !== this.sessionId);
  }

  onPresence(callback) { this.presenceCallback = callback; }
  onStatus(callback)   { this.statusCallback = callback; }

  // Call after registering onPresence to catch any sync event that fired
  // before the callback was set.
  flushPresence() {
    this.presenceCallback?.(this._presencePeers());
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._saveTimer);
    this.doc.off("update", this._onUpdate);
    supabase.removeChannel(this.channel);
    supabase.removeChannel(this.updateChannel);
  }
}

/** Load full history from doc_updates, falling back to a legacy snapshot. */
export async function loadSnapshot(doc, roomId) {
  // Primary: replay all incremental updates in order
  const { data: updates, error: updatesError } = await supabase
    .from("doc_updates")
    .select("y_update")
    .eq("doc_id", roomId)
    .order("id", { ascending: true });

  if (!updatesError && updates?.length) {
    for (const row of updates) {
      try {
        Y.applyUpdate(doc, Uint8Array.from(row.y_update), "remote");
      } catch { /* skip malformed */ }
    }
    return;
  }

  // Fallback: legacy full snapshot
  const { data, error } = await supabase
    .from("document_snapshots")
    .select("snapshot")
    .eq("room_id", roomId)
    .maybeSingle();

  if (error) {
    console.warn("[SupabaseProvider] loadSnapshot error:", error.message);
    return;
  }
  if (data?.snapshot) {
    Y.applyUpdate(doc, new Uint8Array(data.snapshot), "remote");
  }
}
