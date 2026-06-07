"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import seedPrompts from "../data/seed_prompts.json";
import testInputs from "../data/test_inputs.json";
import { streamModel } from "../model_stub";

const STORAGE_KEY = "workshop.shell.v1";
const ROOM_ID = "prompt-workshop:p1";

const people = [
  { id: "u1", name: "You", color: "#1769aa" },
  { id: "u2", name: "Maya", color: "#c2410c" },
  { id: "u3", name: "Noah", color: "#2f855a" },
];

function makePrompt(seed, index) {
  const now = new Date(Date.now() - index * 120000).toISOString();
  return {
    ...seed,
    createdAt: now,
    createdBy: people[index % people.length].id,
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

function createDocFromState(state) {
  const doc = new Y.Doc();
  const meta = doc.getMap("meta");
  const variantMap = doc.getMap("variants");

  meta.set("mainId", state.mainId);
  state.variants.forEach((variant) => {
    const body = new Y.Text();
    body.insert(0, variant.body);
    doc.getMap("bodies").set(variant.id, body);
    variantMap.set(variant.id, { ...variant, body: undefined });
  });

  return doc;
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

function TreeNode({ variant, variants, selectedId, mainId, onSelect, depth = 0 }) {
  const children = variants.filter((item) => item.parentId === variant.id);
  const creator = people.find((person) => person.id === variant.createdBy);

  return (
    <div className="tree-node">
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
        {mainId === variant.id ? <em>Main</em> : null}
        {creator ? <i style={{ background: creator.color }} /> : null}
      </button>
      {children.map((child) => (
        <TreeNode
          key={child.id}
          variant={child}
          variants={variants}
          selectedId={selectedId}
          mainId={mainId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export default function App() {
  const docRef = useRef(null);
  const saveTimer = useRef(null);
  const [state, setState] = useState(makeInitialState);
  const [selectedInputId, setSelectedInputId] = useState(testInputs.inputs[0].id);
  const [editorText, setEditorText] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [runs, setRuns] = useState({});
  const [connection, setConnection] = useState("Shell only");

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    const initial = saved ? JSON.parse(saved) : makeInitialState();
    const doc = createDocFromState(initial);
    docRef.current = doc;
    setState(initial);
    setEditorText(doc.getMap("bodies").get(initial.selectedId)?.toString() ?? "");

    const update = () => {
      setState((current) => {
        const next = snapshotDoc(doc, current.selectedId);
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        }, 150);
        return next;
      });
    };

    doc.on("update", update);
    setConnection("Y.Doc active, websocket provider pending");

    return () => {
      doc.off("update", update);
      doc.destroy();
      window.clearTimeout(saveTimer.current);
    };
  }, []);

  const selectedVariant = state.variants.find((variant) => variant.id === state.selectedId) ?? state.variants[0];
  const selectedInput = testInputs.inputs.find((input) => input.id === selectedInputId) ?? testInputs.inputs[0];
  const roots = state.variants.filter((variant) => !variant.parentId);
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
  }, [selectedVariant?.id]);

  function selectVariant(id) {
    setState((current) => ({ ...current, selectedId: id }));
  }

  function updateEditor(value) {
    const doc = docRef.current;
    const yText = doc?.getMap("bodies").get(selectedVariant.id);
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
      createdBy: "u1",
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
              />
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="section-title">
            <span>Presence</span>
            <b>{people.length}</b>
          </div>
          <div className="presence-list">
            {people.map((person, index) => (
              <div className="person" key={person.id}>
                <span style={{ background: person.color }}>{person.name.slice(0, 1)}</span>
                <div>
                  <strong>{person.name}</strong>
                  <small>{index === 0 ? "Editing here" : `${selectedVariant?.title ?? "Prompt"} cursor ${18 + index * 31}`}</small>
                </div>
              </div>
            ))}
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
            <button className="primary" onClick={() => promoteVariant(selectedVariant.id)}>
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
              {people.slice(1).map((person, index) => (
                <span
                  key={person.id}
                  className="remote-cursor"
                  style={{ left: `${Math.min(92, 24 + index * 34)}%`, background: person.color }}
                  title={`${person.name} cursor`}
                />
              ))}
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
