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
    this._fetchPending = false;
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

    // ── DB-triggered broadcast channel ────────────────────────────────────────
    // Receives lightweight notifications after each insert to doc_updates.
    // On notification: fetches rows with id > _lastSeenId and applies them.
    this.updateChannel = supabase.channel(`doc:${roomId}:updates`);
    this.updateChannel
      .on("broadcast", { event: "y_update_added" }, ({ payload }) => {
        if (this.destroyed) return;
        // Skip updates we inserted ourselves (already applied locally)
        if (payload.client_id === localUser.id) return;
        this._fetchAndApply();
      })
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

  async _fetchAndApply() {
    if (this._fetchPending || this.destroyed) return;
    this._fetchPending = true;
    try {
      const { data, error } = await supabase
        .from("doc_updates")
        .select("id, y_update")
        .eq("doc_id", this.roomId)
        .gt("id", this._lastSeenId)
        .order("id", { ascending: true });

      if (error) {
        console.warn("[SupabaseProvider] fetch failed:", error.message);
        return;
      }

      for (const row of data ?? []) {
        try {
          Y.applyUpdate(this.doc, Uint8Array.from(row.y_update), "remote");
        } catch { /* malformed row — skip */ }
        if (row.id > this._lastSeenId) this._lastSeenId = row.id;
      }
    } finally {
      this._fetchPending = false;
    }
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
