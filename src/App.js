"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import seedPrompts from "../data/seed_prompts.json";
import testInputs from "../data/test_inputs.json";
import { streamModel } from "../model_stub";
import { SupabaseProvider } from "./SupabaseProvider";
import { supabase } from "./supabaseClient";


const STORAGE_KEY = "workshop.shell.v1";
const ROOM_ID = "prompt-workshop:p1";
const IDENTITY_KEY = "workshop.identity.v1";
const SESSION_ID = Math.random().toString(36).slice(2, 10);

const SESSION_COLORS = [
  "#1769aa", "#c2410c", "#2f855a", "#7c3aed", "#b45309",
  "#0e7490", "#be185d", "#4d7c0f", "#9333ea", "#c2410c",
];

function getOrCreateIdentity() {
  if (typeof window === "undefined") return { id: "u1", name: "You", color: SESSION_COLORS[0] };
  const saved = window.localStorage.getItem(IDENTITY_KEY);
  if (saved) return JSON.parse(saved);
  const idx = Math.floor(Math.random() * SESSION_COLORS.length);
  const id = `u-${Math.random().toString(36).slice(2, 8)}`;
  const identity = { id, name: "You", color: SESSION_COLORS[idx] };
  window.localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

const localUser = getOrCreateIdentity();

function makePrompt(seed, index) {
  const now = new Date(Date.now() - index * 120000).toISOString();
  return {
    ...seed,
    createdAt: now,
    createdBy: localUser.id,
  };
}

function makeInitialState() {
  const variants = seedPrompts.prompts.map(makePrompt);
  return {
    variants,
    selectedId: variants[0].id,
    mainId: variants[0].id,
  };
}

function variantLabel(variant, variants) {
  if (!variant.parentId) return "Root";
  const siblingIndex =
    variants.filter((item) => item.parentId === variant.parentId).findIndex((item) => item.id === variant.id) + 1;
  return `v${siblingIndex}`;
}

function populateDocInPlace(doc, state) {
  doc.transact(() => {
    doc.getMap("meta").set("mainId", state.mainId);
    state.variants.forEach((variant) => {
      const body = new Y.Text();
      if (variant.body) body.insert(0, variant.body);
      doc.getMap("bodies").set(variant.id, body);
      doc.getMap("variants").set(variant.id, { ...variant, body: undefined });
    });
  });
}

function snapshotDoc(doc, selectedId) {
  const variantMap = doc.getMap("variants");
  const bodies = doc.getMap("bodies");
  const variants = Array.from(variantMap.entries()).map(([id, data]) => ({
    ...data,
    id,
    body: bodies.get(id)?.toString() ?? "",
  }));

  return {
    variants,
    selectedId,
    mainId: doc.getMap("meta").get("mainId") ?? variants[0]?.id,
  };
}

function applyTextDiff(yText, nextValue) {
  const current = yText.toString();
  if (current === nextValue) return;

  let start = 0;
  while (start < current.length && start < nextValue.length && current[start] === nextValue[start]) {
    start += 1;
  }

  let currentEnd = current.length;
  let nextEnd = nextValue.length;
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === nextValue[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  yText.delete(start, currentEnd - start);
  yText.insert(start, nextValue.slice(start, nextEnd));
}

function TreeNode({ variant, variants, selectedId, mainId, onSelect, onDelete, knownUsers, depth = 0 }) {
  const children = variants.filter((item) => item.parentId === variant.id);
  const creator = knownUsers?.[variant.createdBy];
  const isMain = mainId === variant.id;

  return (
    <div className="tree-node">
      <div className="tree-row">
        <button
          className={`tree-item ${selectedId === variant.id ? "active" : ""}`}
          style={{ paddingLeft: 12 + depth * 18 }}
          onClick={() => onSelect(variant.id)}
        >
          <span className="tree-glyph">{children.length ? "▾" : "•"}</span>
          <span>
            <strong>{variantLabel(variant, variants)}</strong>
            <small>{variant.title}</small>
          </span>
          {isMain ? <em>Main</em> : null}
          {creator ? <i style={{ background: creator.color }} /> : null}
        </button>
        {!isMain && (
          <button
            className="tree-delete"
            title={children.length ? `Delete variant + ${children.length} child(ren)` : "Delete variant"}
            onClick={() => onDelete(variant.id)}
          >
            ×
          </button>
        )}
      </div>
      {children.map((child) => (
        <TreeNode
          key={child.id}
          variant={child}
          variants={variants}
          selectedId={selectedId}
          mainId={mainId}
          onSelect={onSelect}
          onDelete={onDelete}
          knownUsers={knownUsers}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export default function App() {
  const docRef      = useRef(null);
  const listenerRef = useRef(null);
  const saveTimer   = useRef(null);
  const providerRef = useRef(null);
  const [docReady, setDocReady]               = useState(false);
  const [state, setState]                     = useState(makeInitialState);
  const [selectedInputId, setSelectedInputId] = useState(testInputs.inputs[0].id);
  const [editorText, setEditorText]           = useState("");
  const [cursorOffset, setCursorOffset]       = useState(0);
  const [runs, setRuns]                       = useState({});
  const [connection, setConnection]           = useState("connecting…");
  const [peers, setPeers]                     = useState([]);

  useEffect(() => {
    let alive = true;

    async function boot() {
      const doc = new Y.Doc();

      // ── 1. Load canonical state from DB ─────────────────────────────────
      // IMPORTANT: the update listener is NOT registered yet.  Registering it
      // before we finish replaying the DB would fire setState with a partially-
      // populated (or empty) doc, overwriting the initial seed state in React.
      const { data: rows } = await supabase
        .from("doc_updates")
        .select("id, y_update")
        .eq("doc_id", ROOM_ID)
        .order("id", { ascending: true });

      if (!alive) { doc.destroy(); return; }

      let lastSeenId = 0;
      if (rows?.length) {
        for (const row of rows) {
          try { Y.applyUpdate(doc, Uint8Array.from(row.y_update), "remote"); } catch { /* corrupt row — skip */ }
          if (row.id > lastSeenId) lastSeenId = row.id;
        }
      }

      // ── 2. Bootstrap when empty ──────────────────────────────────────────
      // Covers: (a) brand-new room, (b) DB had only orphaned incremental rows
      // whose anchor items don't exist — Y.js silently buffers those forever.
      if (doc.getMap("variants").size === 0) {
        if (rows?.length) {
          // Stale/unresolvable rows — purge so future clients don't loop.
          await supabase.from("doc_updates").delete().eq("doc_id", ROOM_ID);
          lastSeenId = 0;
        }
        localStorage.removeItem(STORAGE_KEY);
        populateDocInPlace(doc, makeInitialState());
        // Write seed as first DB row; all subsequent clients replay this.
        const { data: ins } = await supabase
          .from("doc_updates")
          .insert({ doc_id: ROOM_ID, client_id: localUser.id, y_update: Array.from(Y.encodeStateAsUpdate(doc)) })
          .select("id").single();
        if (ins?.id) lastSeenId = ins.id;
      }

      if (!alive) { doc.destroy(); return; }

      // ── 3. Commit to refs and set React state ────────────────────────────
      docRef.current = doc;

      const allVariants = Array.from(doc.getMap("variants").entries()).map(([id, data]) => ({
        ...data, id, body: doc.getMap("bodies").get(id)?.toString() ?? "",
      }));
      const firstId = allVariants[0]?.id ?? "";
      const mainId  = doc.getMap("meta").get("mainId") ?? firstId;
      setState({ variants: allVariants, selectedId: firstId, mainId });
      setEditorText(doc.getMap("bodies").get(firstId)?.toString() ?? "");

      // ── 4. Register incremental-update listener NOW (after init) ─────────
      const onDocUpdate = () => {
        if (!alive) return;
        setState((cur) => {
          const next = snapshotDoc(doc, cur.selectedId);
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(
            () => localStorage.setItem(STORAGE_KEY, JSON.stringify(next)), 150
          );
          return next;
        });
      };
      listenerRef.current = onDocUpdate;
      doc.on("update", onDocUpdate);

      // ── 5. Signal text-observer effect that docRef is ready ──────────────
      setDocReady(true);

      // ── 6. Connect realtime provider ─────────────────────────────────────
      const provider = new SupabaseProvider(doc, ROOM_ID, localUser, SESSION_ID);
      provider._lastSeenId = lastSeenId;
      providerRef.current = provider;
      provider.onStatus((s) => { if (alive) setConnection(s); });
      provider.onPresence((list) => { if (alive) setPeers(list); });
      provider.flushPresence();
    }

    boot().catch(console.error);

    return () => {
      alive = false;
      if (docRef.current && listenerRef.current) {
        docRef.current.off("update", listenerRef.current);
      }
      providerRef.current?.destroy();
      providerRef.current = null;
      docRef.current?.destroy();
      docRef.current = null;
      window.clearTimeout(saveTimer.current);
    };
  }, []);

  const selectedVariant = state.variants.find((variant) => variant.id === state.selectedId) ?? state.variants[0];
  const selectedInput = testInputs.inputs.find((input) => input.id === selectedInputId) ?? testInputs.inputs[0];
  const roots = state.variants.filter((variant) => !variant.parentId);
  const knownUsers = useMemo(() => {
    const map = { [localUser.id]: localUser };
    peers.forEach((p) => { if (p.id && p.color) map[p.id] = p; });
    return map;
  }, [peers]);
  const activeVariants = useMemo(() => {
    if (!selectedVariant) return [];
    const rootId = selectedVariant.parentId
      ? findRootId(selectedVariant, state.variants)
      : selectedVariant.id;
    const descendants = collectTree(rootId, state.variants);
    return descendants.slice(0, 4);
  }, [selectedVariant, state.variants]);

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !selectedVariant) return;
    const text = doc.getMap("bodies").get(selectedVariant.id);
    setEditorText(text?.toString() ?? "");

    const update = () => setEditorText(text.toString());
    text.observe(update);
    return () => text.unobserve(update);
  }, [selectedVariant?.id, docReady]);

  useEffect(() => {
    providerRef.current?.sendCursor(cursorOffset, selectedVariant?.id ?? null);
  }, [cursorOffset, selectedVariant?.id]);

  function selectVariant(id) {
    setState((current) => ({ ...current, selectedId: id }));
  }

  function updateEditor(value) {
    const doc = docRef.current;
    if (!doc || !selectedVariant) return;
    const yText = doc.getMap("bodies").get(selectedVariant.id);
    if (!yText) return;
    doc.transact(() => applyTextDiff(yText, value));
    setEditorText(value);
  }

  function updateCursor(event) {
    setCursorOffset(event.currentTarget.selectionStart ?? 0);
  }

  function forkVariant() {
    const doc = docRef.current;
    if (!doc || !selectedVariant) return;
    const id = `v-${Date.now().toString(36)}`;
    const nextVariant = {
      id,
      title: `${selectedVariant.title} fork`,
      parentId: selectedVariant.id,
      createdAt: new Date().toISOString(),
      createdBy: localUser.id,
    };

    doc.transact(() => {
      const body = new Y.Text();
      body.insert(0, editorText);
      doc.getMap("bodies").set(id, body);
      doc.getMap("variants").set(id, nextVariant);
    });
    selectVariant(id);
  }

  function promoteVariant(id) {
    const doc = docRef.current;
    if (!doc) return;
    doc.transact(() => doc.getMap("meta").set("mainId", id));
  }

  function deleteVariant(id) {
    const doc = docRef.current;
    if (!doc) return;
    if (id === state.mainId) return; // main is protected

    // Collect the target + every descendant
    const toDelete = new Set(collectTree(id, state.variants).map((v) => v.id));

    doc.transact(() => {
      for (const vid of toDelete) {
        doc.getMap("variants").delete(vid);
        doc.getMap("bodies").delete(vid);
      }
    });

    // If the currently selected variant was deleted, navigate to parent or first survivor
    if (toDelete.has(state.selectedId)) {
      const deleted = state.variants.find((v) => v.id === id);
      const fallbackId =
        (deleted?.parentId && !toDelete.has(deleted.parentId) ? deleted.parentId : null) ??
        state.variants.find((v) => !toDelete.has(v.id))?.id;
      if (fallbackId) selectVariant(fallbackId);
    }
  }

  async function resetToSeed() {
    const doc = docRef.current;
    if (!doc) return;

    // Purge all DB history for this room
    await supabase.from("doc_updates").delete().eq("doc_id", ROOM_ID);
    localStorage.removeItem(STORAGE_KEY);

    const seed = makeInitialState();
    // Use "remote" origin so SupabaseProvider._onUpdate skips the delta insert —
    // we write a clean full snapshot ourselves below.
    doc.transact(() => {
      doc.getMap("meta").set("mainId", seed.mainId);
      doc.getMap("variants").clear();
      doc.getMap("bodies").clear();
      seed.variants.forEach((variant) => {
        const body = new Y.Text();
        body.insert(0, variant.body);
        doc.getMap("bodies").set(variant.id, body);
        doc.getMap("variants").set(variant.id, { ...variant, body: undefined });
      });
    }, "remote");

    // Write clean full snapshot so any new client boots from one unambiguous row
    const fullSnapshot = Y.encodeStateAsUpdate(doc);
    await supabase
      .from("doc_updates")
      .insert({ doc_id: ROOM_ID, client_id: localUser.id, y_update: Array.from(fullSnapshot) });

    // Push the full snapshot to currently connected peers so they don't reload
    providerRef.current?.channel.send({
      type: "broadcast",
      event: "y-update",
      payload: { update: Array.from(fullSnapshot) },
    });

    const resetFirstId = seed.variants[0].id;
    selectVariant(resetFirstId);
    // Refresh editorText directly — text-observer won't re-fire if the selected
    // variant id was already resetFirstId (dep array wouldn't change).
    setEditorText(doc.getMap("bodies").get(resetFirstId)?.toString() ?? "");
    setRuns({});
  }

  async function runAll() {
    const started = Date.now();
    const selectedVariants = activeVariants;
    selectedVariants.forEach((variant) => {
      setRuns((current) => ({
        ...current,
        [variant.id]: {
          variantId: variant.id,
          inputId: selectedInput.id,
          output: "",
          status: "streaming",
          startedAt: started,
        },
      }));

      streamVariant(variant, selectedInput, started);
    });
  }

  async function streamVariant(variant, input, startedAt) {
    try {
      for await (const chunk of streamModel(variant.body, input.text, { slow: variant.id.endsWith("2") })) {
        setRuns((current) => {
          const existing = current[variant.id];
          return {
            ...current,
            [variant.id]: {
              ...existing,
              output: `${existing?.output ?? ""}${chunk.text}`,
              status: chunk.done ? "complete" : "streaming",
              durationMs: chunk.done ? Date.now() - startedAt : undefined,
            },
          };
        });
      }
    } catch (error) {
      setRuns((current) => ({
        ...current,
        [variant.id]: {
          ...current[variant.id],
          status: "error",
          error: error.message,
        },
      }));
    }
  }

  const cursorPercent = Math.min(96, Math.max(4, editorText.length ? (cursorOffset / editorText.length) * 100 : 4));

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <span>W</span>
          <div>
            <h1>Workshop</h1>
            <p>{connection}</p>
          </div>
          <button className="reset-btn" title="Reset to seed prompts" onClick={resetToSeed}>↺</button>
        </div>

        <section className="sidebar-section">
          <div className="section-title">
            <span>Variant tree</span>
            <button onClick={forkVariant} title="Fork selected prompt">+</button>
          </div>
          <div className="tree">
            {roots.map((root) => (
              <TreeNode
                key={root.id}
                variant={root}
                variants={state.variants}
                selectedId={selectedVariant?.id}
                mainId={state.mainId}
                onSelect={selectVariant}
                onDelete={deleteVariant}
                knownUsers={knownUsers}
              />
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-title">
            <span>Presence</span>
            <b>{1 + peers.length}</b>
          </div>
          <div className="presence-list">
            <div className="person" key={localUser.id}>
              <span style={{ background: localUser.color }}>{localUser.name.slice(0, 1)}</span>
              <div>
                <strong>{localUser.name}</strong>
                <small>Editing here</small>
              </div>
            </div>
            {peers.map((peer) => {
              const editingVariant = peer.variantId
                ? state.variants.find((v) => v.id === peer.variantId)
                : null;
              return (
                <div className="person" key={peer.sessionId ?? peer.id}>
                  <span style={{ background: peer.color ?? "#888" }}>{(peer.name ?? "?").slice(0, 1)}</span>
                  <div>
                    <strong>{peer.name ?? peer.id}</strong>
                    <small>{editingVariant ? `editing ${editingVariant.title}` : "connected"}</small>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </aside>

      <section className="editor-pane">
        <header className="topbar">
          <div>
            <p>Room {ROOM_ID}</p>
            <h2>{selectedVariant?.title}</h2>
          </div>
          <div className="actions">
            <button onClick={forkVariant}>Fork</button>
            {selectedVariant && state.mainId !== selectedVariant.id && (
              <button className="danger" onClick={() => deleteVariant(selectedVariant.id)}>
                Delete
              </button>
            )}
            <button className="primary" onClick={() => selectedVariant && promoteVariant(selectedVariant.id)}>
              Promote to main
            </button>
          </div>
        </header>

        <section className="editor-band">
          <div className="editor-meta">
            <span>{state.mainId === selectedVariant?.id ? "Current main" : "Variant draft"}</span>
            <span>{editorText.length} chars</span>
          </div>
          <div className="textarea-wrap">
            <textarea
              value={editorText}
              onChange={(event) => updateEditor(event.target.value)}
              onSelect={updateCursor}
              onKeyUp={updateCursor}
              spellCheck="false"
            />
            <div className="cursor-track">
              {peers
                .filter((peer) => peer.variantId === selectedVariant?.id)
                .map((peer) => {
                  const pct = Math.min(96, Math.max(4, editorText.length ? (peer.cursor / editorText.length) * 100 : 4));
                  return (
                    <span
                      key={peer.id}
                      className="remote-cursor"
                      style={{ left: `${pct}%`, background: peer.color ?? "#888" }}
                      title={`${peer.name ?? peer.id} cursor`}
                    />
                  );
                })}
              <span className="local-cursor" style={{ left: `${cursorPercent}%` }} />
            </div>
          </div>
        </section>
      </section>

      <aside className="run-pane">
        <section className="test-panel">
          <div className="section-title">
            <span>Test input</span>
            <button className="run-button" onClick={runAll}>Run all</button>
          </div>
          <select value={selectedInputId} onChange={(event) => setSelectedInputId(event.target.value)}>
            {testInputs.inputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.label}
              </option>
            ))}
          </select>
          <p>{selectedInput.text}</p>
        </section>

        <section className="outputs">
          <div className="section-title">
            <span>Streaming outputs</span>
            <b>{activeVariants.length}</b>
          </div>
          <div className="output-grid">
            {activeVariants.map((variant) => {
              const run = runs[variant.id];
              return (
                <article key={variant.id} className="output-card">
                  <header>
                    <div>
                      <strong>{variantLabel(variant, state.variants)}</strong>
                      <span>{variant.title}</span>
                    </div>
                    <button onClick={() => promoteVariant(variant.id)}>
                      {state.mainId === variant.id ? "Main" : "Promote"}
                    </button>
                  </header>
                  <pre>{run?.output || "Ready for the next shared input run."}</pre>
                  <footer className={run?.status ?? "idle"}>
                    {run?.status ?? "idle"}
                    {run?.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}
                  </footer>
                </article>
              );
            })}
          </div>
        </section>
      </aside>
    </main>
  );
}

function findRootId(variant, variants) {
  let current = variant;
  while (current?.parentId) {
    current = variants.find((item) => item.id === current.parentId);
  }
  return current?.id ?? variant.id;
}

function collectTree(rootId, variants) {
  const root = variants.find((variant) => variant.id === rootId);
  if (!root) return [];
  const result = [root];
  const walk = (parentId) => {
    variants
      .filter((variant) => variant.parentId === parentId)
      .forEach((child) => {
        result.push(child);
        walk(child.id);
      });
  };
  walk(rootId);
  return result;
}
