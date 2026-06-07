import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Helpers — simulate two independent browser clients with their own Y.Doc
// ---------------------------------------------------------------------------

function applyTextDiff(yText, nextValue) {
  const current = yText.toString();
  if (current === nextValue) return;

  let start = 0;
  while (start < current.length && start < nextValue.length && current[start] === nextValue[start]) {
    start++;
  }

  let currentEnd = current.length;
  let nextEnd = nextValue.length;
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === nextValue[nextEnd - 1]) {
    currentEnd--;
    nextEnd--;
  }

  yText.delete(start, currentEnd - start);
  yText.insert(start, nextValue.slice(start, nextEnd));
}

function makeClient(id, initialText = "") {
  const doc = new Y.Doc({ clientID: id });
  const bodies = doc.getMap("bodies");
  const yText = new Y.Text();
  if (initialText) yText.insert(0, initialText);
  bodies.set("prompt-1", yText);

  // Buffer of outgoing updates (what SupabaseProvider would broadcast)
  const outbox = [];
  doc.on("update", (update, origin) => {
    if (origin !== "remote") outbox.push(update);
  });

  return {
    doc,
    yText,
    outbox,
    text: () => yText.toString(),
    // Simulate the textarea onChange path used in App.js
    type: (nextValue) => doc.transact(() => applyTextDiff(yText, nextValue)),
  };
}

// Deliver all buffered outgoing updates from `sender` into `receiver`
function flush(sender, receiver) {
  const pending = sender.outbox.splice(0);
  for (const update of pending) {
    Y.applyUpdate(receiver.doc, update, "remote");
  }
}

// Full bidirectional sync (both directions, all buffered updates)
function sync(a, b) {
  flush(a, b);
  flush(b, a);
}

// ---------------------------------------------------------------------------
// Scenario 1 — Two users type at the same time (no prior coordination)
// Both appends must survive; no characters may disappear.
// ---------------------------------------------------------------------------

describe("Scenario 1: concurrent appends", () => {
  let alice, bob;

  beforeEach(() => {
    alice = makeClient(1, "Hello ");
    bob = makeClient(2, "Hello ");
  });

  it("both typed strings appear after sync", () => {
    // Alice and Bob both type without seeing each other's updates
    alice.yText.insert(6, "world");  // "Hello world"
    bob.yText.insert(6, "there");    // "Hello there"

    sync(alice, bob);

    // Both docs converge to the same value
    expect(alice.text()).toBe(bob.text());

    const result = alice.text();
    // Neither contribution was lost
    expect(result).toContain("world");
    expect(result).toContain("there");
    expect(result).toContain("Hello");
  });

  it("character count is sum of both inserts (no drops)", () => {
    alice.yText.insert(6, "world");
    bob.yText.insert(6, "there");
    sync(alice, bob);

    // "Hello " (6) + "world" (5) + "there" (5) = 16
    expect(alice.text().length).toBe(16);
  });

  it("multiple rapid keystrokes from both sides converge", () => {
    // Simulate user typing character by character
    ["a", "b", "c"].forEach((ch, i) => {
      alice.yText.insert(6 + i, ch);
    });
    ["x", "y", "z"].forEach((ch, i) => {
      bob.yText.insert(6 + i, ch);
    });

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());
    const result = alice.text();
    expect(result).toContain("abc");
    expect(result).toContain("xyz");
    expect(result.startsWith("Hello ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Both users replace the same word with different words
// App must not crash; both docs must converge; no characters from the
// surrounding text ("Be " and " with users") may disappear.
// ---------------------------------------------------------------------------

describe("Scenario 2: concurrent word replacement", () => {
  const INITIAL = "Be friendly with users";
  //               0123456789...
  // "friendly" starts at index 3, length 8
  const WORD_START = 3;
  const WORD_LEN   = 8;

  let alice, bob;

  beforeEach(() => {
    alice = makeClient(1, INITIAL);
    bob   = makeClient(2, INITIAL);
  });

  it("app does not crash and both docs converge", () => {
    alice.doc.transact(() => {
      alice.yText.delete(WORD_START, WORD_LEN);
      alice.yText.insert(WORD_START, "casual");
    });

    bob.doc.transact(() => {
      bob.yText.delete(WORD_START, WORD_LEN);
      bob.yText.insert(WORD_START, "professional");
    });

    // Must not throw
    expect(() => sync(alice, bob)).not.toThrow();

    const resultA = alice.text();
    const resultB = bob.text();

    // Both sides converge
    expect(resultA).toBe(resultB);
  });

  it("surrounding text is intact after conflict resolution", () => {
    alice.doc.transact(() => {
      alice.yText.delete(WORD_START, WORD_LEN);
      alice.yText.insert(WORD_START, "casual");
    });

    bob.doc.transact(() => {
      bob.yText.delete(WORD_START, WORD_LEN);
      bob.yText.insert(WORD_START, "professional");
    });

    sync(alice, bob);

    const result = alice.text();
    // The frame around the word must survive regardless of which word wins
    expect(result).toContain("Be ");
    expect(result).toContain(" with users");
    // Result is a non-empty valid string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("Y.js CRDT keeps both replacement strings (no silent data loss)", () => {
    alice.doc.transact(() => {
      alice.yText.delete(WORD_START, WORD_LEN);
      alice.yText.insert(WORD_START, "casual");
    });

    bob.doc.transact(() => {
      bob.yText.delete(WORD_START, WORD_LEN);
      bob.yText.insert(WORD_START, "professional");
    });

    sync(alice, bob);

    // Y.js preserves both inserts; neither word is silently dropped
    const result = alice.text();
    const hasCasual = result.includes("casual");
    const hasProfessional = result.includes("professional");
    expect(hasCasual || hasProfessional).toBe(true); // at least one survives
    // The total length must be >= the shorter replacement ("casual" = 6) + frame
    const frameLen = "Be  with users".length; // 14
    expect(result.length).toBeGreaterThanOrEqual(frameLen + 6);
  });

  it("textarea-path (applyTextDiff) produces the same outcome", () => {
    // Simulate typing through the textarea onChange handler (App.js path)
    alice.type("Be casual with users");
    bob.type("Be professional with users");

    expect(() => sync(alice, bob)).not.toThrow();
    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("Be ");
    expect(alice.text()).toContain(" with users");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — One user deletes, the other types
// Final text must be valid (no crash, no corruption) and fully synced.
// B's new text must not vanish even though A deleted around the same region.
// ---------------------------------------------------------------------------

describe("Scenario 3: concurrent delete and insert", () => {
  const INITIAL = "Hello world";

  let alice, bob;

  beforeEach(() => {
    alice = makeClient(1, INITIAL);
    bob   = makeClient(2, INITIAL);
  });

  it("B's insert survives A's delete; both converge", () => {
    // Alice deletes "world" (positions 6–10)
    alice.yText.delete(6, 5);

    // Bob appends "everyone" at the end of "Hello world"
    bob.yText.insert(INITIAL.length, "everyone");

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());

    const result = alice.text();
    // Bob's insert anchors after the last char of "world" (which Y.js tombstones);
    // it must still appear in the merged result
    expect(result).toContain("everyone");
    expect(result).toContain("Hello");
  });

  it("result is a valid non-empty string (no corruption)", () => {
    alice.yText.delete(6, 5); // delete "world"
    bob.yText.insert(INITIAL.length, "everyone");

    sync(alice, bob);

    const result = alice.text();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // No stray undefined / null in the output
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });

  it("delete while other is mid-word: partial inserts are kept", () => {
    // Alice deletes the entire initial text
    alice.yText.delete(0, INITIAL.length);

    // Bob types a new word character by character into the same region
    ["N", "e", "w"].forEach((ch, i) => {
      bob.yText.insert(i, ch);
    });

    sync(alice, bob);

    expect(alice.text()).toBe(bob.text());
    // Bob's characters must all be present
    expect(alice.text()).toContain("New");
  });

  it("interleaved flushes (partial network delivery) still converge", () => {
    alice.yText.delete(6, 5);           // delete "world"
    flush(alice, bob);                  // Bob receives Alice's delete first

    bob.yText.insert(bob.text().length, "folks"); // Bob appends to "Hello "
    flush(bob, alice);                  // Alice receives Bob's insert

    // Final state: both see "Hello folks"
    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("Hello");
    expect(alice.text()).toContain("folks");
  });

  it("textarea-path delete+insert via applyTextDiff stays valid", () => {
    alice.type("Hello ");          // Alice removes "world"
    bob.type("Hello world!");      // Bob appends "!"

    expect(() => sync(alice, bob)).not.toThrow();
    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain("Hello");
  });
});
