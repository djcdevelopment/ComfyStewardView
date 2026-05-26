# PR draft for Kakoen/valheim-save-tools

Two independent fixes, both surfaced while parsing a 1.1 GB world v35 / inventory v106 save from a live Comfy Valheim community server (ComfyEra14, 8M ZDOs, May 2026).

Suggested PR title: **Support world v35 + inventory v106, and fix `readNumItems` unsigned-byte bug**

---

## Patch 1 — `ZPackage.readNumItems` reads the 2-byte count's low byte as signed

**Bug.** For world version 33+, `readNumItems` reads a 1- or 2-byte var-int count. When the count is in `[128, 32767]`, the second byte is treated as a signed Java `byte` and gets sign-extended on the bitwise-OR. For any second-byte value `>= 0x80`, the result becomes a negative `int`, the surrounding `for (int i = 0; i < count; i++)` loop never executes, the bag's data is silently skipped, and the ZPackage stream drifts.

**Trigger frequency.** Any ZDO bag with 128–255 entries in *any* of the typed bags (floats/vec3s/quats/ints/longs/strings/byteArrays) hits this. Common in older megabases with many overlapping dig actions, walls with shared shadow data, etc. In ComfyEra14 the first hit was at ZDO #1,024,261 of 8,016,512.

**Symptom.** Cascading `IllegalStateException` from `ZPackage.readString` / `readStringLength` somewhere later in the file ("String length cannot be read at position N"), often after millions of ZDOs parse fine — the drift only manifests when the misaligned bytes happen to encode invalid string-length varints.

**Fix.** Mask both byte reads to unsigned:
```java
int num = readByte() & 0xFF;
if ((num & 128) != 0) {
    num = ((num & 127) << 8) | (readByte() & 0xFF);
}
```

Could add a regression test that hand-constructs a ZPackage with a strings bag of size 200 and asserts the read count matches.

---

## Patch 2 — Inventory format v106 support (5 trailing bytes per item)

**What changed.** As of game version 0.221.x (post-Bog Witch maintenance/PTB era, observed in worlds saved in 2025), `Inventory.Save` bumped from version 104 to **106** and added two fields per `InventoryItem`, immediately after `customData`:

| Field | Type | Default observed |
|---|---|---|
| (hypothesized) `worldLevel` | `int32` | 0 |
| (hypothesized) `pickedUp`   | `bool`  | true |

Names are best-guesses based on what's currently public about Iron Gate's world-level mechanics — happy to rename when someone confirms against the decompiled `Inventory.cs`. The bytes are what's load-bearing; the field names can change without changing the binary contract.

**Verification.** I reverse-engineered this by parsing a v106 container per the v104 layout, then scanning forward for the next item's plausible name varint (single-byte length 1–32 followed by ASCII `[A-Za-z0-9_]`). Hundreds of probed items across Player_tombstones, piece_chest_wood, and modded containers all had exactly 5 trailing bytes in the same `00 00 00 00 01` pattern. After the patch, 61,289 / 61,289 containers in ComfyEra14 decode with zero parse errors.

**v105.** Never observed in the sample; the gate is `version >= 106` to be conservative. If someone produces a v105 save we should investigate before extending the gate.

**Patch.**
```java
// In InventoryItem fields:
private int worldLevel;
private boolean pickedUp;

// In InventoryItem(ZPackage, int) at the end:
worldLevel = version >= 106 ? zPackage.readInt32() : 0;
pickedUp = version >= 106 ? zPackage.readBool() : true;

// In InventoryItem.save() at the end:
writer.writeInt32(worldLevel);
writer.writeBool(pickedUp);

// In Inventory:
private static final int MAX_SUPPORTED_INVENTORY_VERSION = 106;
```

---

## Patch 3 — `MAX_SUPPORTED_WORLD_VERSION` 34 → 35

Trivial one-line bump. Comes alongside the inventory v106 bump because if you're reading a v35 world you're almost certainly seeing v106 inventories. World structure itself is unchanged from v34; the failure is just the explicit version gate, and the existing `failOnUnsupportedVersion=false` flag has always degraded gracefully.

---

## Unified diff

The complete patch is in `D:\work\comfy\kakoen-comfyera14.patch` (this repo's local working tree). Four files, ~10 lines net change.

---

## Notes for the maintainer

- **License.** The Kakoen repo currently has no `LICENSE` file. Worth declaring something explicit (MIT / Apache-2.0 are the usual choices for OSS Java libs) — without it, technically "all rights reserved" applies, which discourages forks. Independent of this PR.
- **Streaming.** For 8M-ZDO worlds the current "load entire `zdoList` into a Java `ArrayList`" pattern is RAM-hungry (~8 GB heap on a 1.1 GB save when fully materialized as JSON). Not addressed in this PR; would be a larger refactor offering an `EventHandler<Zdo>` style API. Mentioned for context.
