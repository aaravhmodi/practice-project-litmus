import { describe, it, expect } from "vitest";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same diff logic as App.js – converts a textarea string into Y.js ops */
function applyTextDiff(yText, nextValue) {
  const current = yText.toString();
  if (current === nextValue) return;

  let start = 0;
  while (start < current.length && start < nextValue.length && current[start] === nextValue[start]) {
    start++;
  }
  let cEnd = current.length;
  let nEnd = nextValue.length;
  while (cEnd > start && nEnd > start && current[cEnd - 1] === nextValue[nEnd - 1]) {
    cEnd--;
    nEnd--;
  }
  yText.delete(start, cEnd - start);
  yText.insert(start, nextValue.slice(start, nEnd));
}

/**
 * Create two clients that share the same initial document state.
 *
 * Y.js updates reference items by (clientID, clock) pair.  If two docs
 * build their initial text independently they end up with DIFFERENT item
 * IDs for every character – inserts from one doc can't be integrated into
 * the other because the anchor items are missing.
 *
 * The fix: one "root" doc writes the seed text; both clients start from an
 * encoded snapshot of that root so they share the same item history.
 */
function makeClients(initialText = "") {
  // Root doc holds canonical initial state
  const root = new Y.Doc();
  const rootText = new Y.Text();
  root.getMap("bodies").set("prompt-1", rootText);
  if (initialText) rootText.insert(0, initialText);
  const snapshot = Y.encodeStateAsUpdate(root);

  function client(clientID) {
    const doc = new Y.Doc({ clientID });
    // Apply with "remote" origin so the outbox listener below ignores it
    Y.applyUpdate(doc, snapshot, "remote");
    const yText = doc.getMap("bodies").get("prompt-1");

    const outbox = [];
    doc.on("update", (update, origin) => {
      if (origin !== "remote") outbox.push(update);
    });

    return {
      doc,
      yText,
      outbox,
      text: () => yText.toString(),
      // Simulate user typing through the textarea (App.js updateEditor path)
      type: (v) => doc.transact(() => applyTextDiff(yText, v)),
    };
  }

  return { alice: client(1), bob: client(2) };
}

/** Deliver all buffered outgoing updates from sender → receiver */
function flush(sender, receiver) {
  for (const update of sender.outbox.splice(0)) {
    Y.applyUpdate(receiver.doc, update, "remote");
  }
}

/** Full bidirectional exchange (both directions) */
function sync(a, b) {
  flush(a, b);
  flush(b, a);
}

// ---------------------------------------------------------------------------
// Scenario 1 — Two users type simultaneously
// Expected: both edits appear, no characters disappear.
// ---------------------------------------------------------------------------
describe("Scenario 1: concurrent appends", () => {
  it("both typed strings appear after sync", () => {
    const { alice, bob } = makeClients("Hello ");

    // No coordination – each types without seeing the other
    alice.yText.insert(6, "world");
    bob.yText.insert(6, "there");

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text()); // must converge
    expect(alice.text()).toContain("world");
    expect(alice.text()).toContain("there");
    expect(alice.text()).toContain("Hello ");
  });

  it("no characters are dropped (total length = sum of both inserts)", () => {
    const { alice, bob } = makeClients("Hello ");

    alice.yText.insert(6, "world"); // +5
    bob.yText.insert(6, "there");   // +5

    sync(alice, bob);

    // "Hello " (6) + "world" (5) + "there" (5) = 16
    expect(alice.text().length).toBe(16);
  });

  it("rapid character-by-character typing from both sides converges", () => {
    const { alice, bob } = makeClients("Hello ");

    // Each types 3 chars without seeing the other
    ["a", "b", "c"].forEach((ch, i) => alice.yText.insert(6 + i, ch));
    ["x", "y", "z"].forEach((ch, i) => bob.yText.insert(6 + i, ch));

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("abc");
    expect(alice.text()).toContain("xyz");
    expect(alice.text().startsWith("Hello ")).toBe(true);
  });

  it("textarea-path (type()) also converges without drops", () => {
    const { alice, bob } = makeClients("Hello ");

    alice.type("Hello world");
    bob.type("Hello there");

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("Hello");
    // At least one of the words must survive (CRDT may keep both)
    const hasWord = alice.text().includes("world") || alice.text().includes("there");
    expect(hasWord).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Both users edit the same word at the same time
// ("friendly" → "casual" by Alice, "friendly" → "professional" by Bob)
// Expected: app does not crash or overwrite; both docs converge.
// ---------------------------------------------------------------------------
describe("Scenario 2: concurrent word replacement", () => {
  const INITIAL    = "Be friendly with users";
  const WORD_START = 3;  // "Be " is 3 chars
  const WORD_LEN   = 8;  // "friendly"

  it("app does not crash and both docs converge to same text", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.doc.transact(() => {
      alice.yText.delete(WORD_START, WORD_LEN);
      alice.yText.insert(WORD_START, "casual");
    });
    bob.doc.transact(() => {
      bob.yText.delete(WORD_START, WORD_LEN);
      bob.yText.insert(WORD_START, "professional");
    });

    expect(() => sync(alice, bob)).not.toThrow();
    expect(alice.text()).toBe(bob.text());
  });

  it("the surrounding frame is always intact", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.doc.transact(() => { alice.yText.delete(WORD_START, WORD_LEN); alice.yText.insert(WORD_START, "casual"); });
    bob.doc.transact(() => { bob.yText.delete(WORD_START, WORD_LEN); bob.yText.insert(WORD_START, "professional"); });

    sync(alice, bob);

    expect(alice.text()).toContain("Be ");
    expect(alice.text()).toContain(" with users");
  });

  it("original word 'friendly' is gone after both deletions", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.doc.transact(() => { alice.yText.delete(WORD_START, WORD_LEN); alice.yText.insert(WORD_START, "casual"); });
    bob.doc.transact(() => { bob.yText.delete(WORD_START, WORD_LEN); bob.yText.insert(WORD_START, "professional"); });

    sync(alice, bob);

    // Both clients delete the exact same Y.js items → tombstoned in both
    expect(alice.text()).not.toContain("friendly");
  });

  it("Y.js CRDT keeps BOTH replacement words (no silent overwrite)", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.doc.transact(() => { alice.yText.delete(WORD_START, WORD_LEN); alice.yText.insert(WORD_START, "casual"); });
    bob.doc.transact(() => { bob.yText.delete(WORD_START, WORD_LEN); bob.yText.insert(WORD_START, "professional"); });

    sync(alice, bob);

    const result = alice.text();
    // CRDTs preserve all concurrent inserts — neither word silently dropped
    expect(result).toContain("casual");
    expect(result).toContain("professional");
  });

  it("textarea-path concurrent replacement also converges without crash", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.type("Be casual with users");
    bob.type("Be professional with users");

    expect(() => sync(alice, bob)).not.toThrow();
    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("Be ");
    expect(alice.text()).toContain(" with users");
    expect(alice.text()).not.toContain("friendly");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — One user deletes while the other types
// Expected: final text is valid and fully synced; inserted text survives.
// ---------------------------------------------------------------------------
describe("Scenario 3: concurrent delete and insert", () => {
  const INITIAL = "Hello world";

  it("B's insert survives A's delete — both docs converge", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.yText.delete(6, 5);                    // Alice removes "world"
    bob.yText.insert(INITIAL.length, "everyone"); // Bob appends after "world"

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());

    const result = alice.text();
    // Bob's insert was anchored after the tombstoned "d"; it survives
    expect(result).toContain("everyone");
    expect(result).toContain("Hello");
    expect(result).not.toContain("world"); // Alice's delete wins on the base word
  });

  it("result is a valid non-empty string with no corruption", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.yText.delete(6, 5);
    bob.yText.insert(INITIAL.length, "everyone");

    sync(alice, bob);

    const result = alice.text();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });

  it("full delete while other types new text: new text is kept", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.yText.delete(0, INITIAL.length); // Alice clears everything

    // Bob types three chars at the beginning
    bob.yText.insert(0, "N");
    bob.yText.insert(1, "e");
    bob.yText.insert(2, "w");

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());
    // Bob's chars anchored before the original text survive the full delete
    expect(alice.text()).toContain("New");
  });

  it("interleaved flushes (partial delivery) still converge correctly", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.yText.delete(6, 5);  // Alice deletes "world" first
    flush(alice, bob);          // Bob receives the delete immediately

    // Bob sees "Hello " and appends "folks" at the end
    bob.yText.insert(bob.text().length, "folks");
    flush(bob, alice);          // Alice receives Bob's insert

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toBe("Hello folks");
  });

  it("textarea-path delete + insert via type() stays valid and synced", () => {
    const { alice, bob } = makeClients(INITIAL);

    alice.type("Hello ");        // Alice removes "world" via textarea
    bob.type("Hello world!");    // Bob appends "!" via textarea

    expect(() => sync(alice, bob)).not.toThrow();
    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("Hello");
    // "!" was appended — must survive regardless of Alice's delete
    expect(alice.text()).toContain("!");
  });
});
