# Pre-Build Data Contracts — LOCKED
# ComfyEra14.db / Valheim World Viewer
# Verified by PreBuildProbes.java run 2026-03-18

---

## 1. TIME / DATE CONTRACT  ✅ LOCKED

**spawntime unit: MICROSECONDS of world time**

```
spawntime_seconds = spawntime_long / 1_000_000.0
netTime_seconds   = netTime_double  (file header, already in seconds)

fraction_of_world_life = spawntime_seconds / netTime_seconds
  → 0.0 = spawned at world creation
  → 1.0 = spawned right when this snapshot was saved
  → >1.0 = edge case: items from before a server reset/world port (VALID, handle gracefully)

In-game days since world start = spawntime_seconds / 1200.0
```

**API representation:**
```json
"spawntime": {
  "raw": 9628870783697,
  "seconds": 9628870.8,
  "worldFraction": 0.9009,
  "ingameDays": 8024.1
}
```

**Filter API parameter:** `?spawnedAfterFraction=0.9&spawnedBeforeFraction=1.0`
(Do NOT use absolute seconds — world may differ between saves)

**Edge cases:**
- worldFraction > 1.0 → item predates current save's clock (show as "very old" or exact age relative to netTime)
- worldFraction = 0 or null → no spawntime on this ZDO (building piece, nature object)
- `timeOfDeath` on tombstones = same unit (microseconds)
- `lastTime` on portals/torches = same unit (microseconds)

---

## 2. PLAYER IDENTITY CONTRACT  ✅ LOCKED

**Two incompatible formats — no automatic bridge:**

```
Format A: Internal ID (32-bit, stored as signed Long)
  - Source: longs["owner"]  on beds, longs["creator"] on buildings
  - Example: 2871732148, -201870991, 1507498093
  - Range: fits in 32 bits (some appear negative = top bit set)
  - Cannot be converted to Steam64 without external lookup

Format B: Steam64 string (full 64-bit, stored as string)
  - Source: strings["author"] on signs and portals
  - Format: "Steam_76561198050938512"
  - Parse: Long.parseLong(author.substring(6))
  - NO ZDO property links Format A to Format B automatically
```

**Player resolution strategy:**
```
PRIMARY source (Name + InternalId):
  bed.longs["owner"] + bed.strings["ownerName"]  → 434 players with names

SECONDARY source (Name only, no Id):
  tombstone.strings["ownerName"]                 → death list, no internal ID

TERTIARY source (Steam64 + Internal Id, rare):
  sign.strings["author"] + sign.longs["creator"]
  If same player built sign AND set sign tag → can cross-reference
  Coverage: limited, confidence = INFERRED

FALLBACK display:
  displayName = ownerName if known, else "Player #" + internalId
```

**PlayerIdentity schema:**
```json
{
  "internalId": 2871732148,
  "displayName": "Santaclawspark",
  "steam64": null,
  "nameSource": "BED_OWNER",
  "confidence": "NAME_CONFIRMED"
}
```

**confidence values:** `NAME_CONFIRMED | INFERRED | ID_ONLY | ANONYMOUS`

---

## 3. BED PREFAB CONTRACT  ✅ LOCKED

**Player beds (use ALL of these):**
```
"bed"         → 1,257 ZDOs  [ownerName string, owner long, creator long, spawntime long]
"piece_bed02" → 711 ZDOs    [ownerName string, owner long, creator long]
Total: 1,968 player beds
```

**Filter out:**
```
"goblin_bed"  → 2,331 ZDOs  = Fuling NPC camp beds (no ownerName, no owner)
```

**Bed ZDO properties:**
```
strings["ownerName"]  → display name (may be empty string for unclaimed)
longs["owner"]        → internal player ID (0 = unclaimed)
longs["creator"]      → builder (may differ from owner if admin-placed)
longs["spawntime"]    → when bed was placed (microseconds)
```

---

## 4. TOMBSTONE CONTRACT  ✅ LOCKED

**Prefab:** `Player_tombstone`

**Properties:**
```
strings["ownerName"]          → player display name (always present)
strings["items"]              → Base64 inventory blob (FULL player inventory at death!)
longs["owner"]                → internal player ID
longs["timeOfDeath"]          → death timestamp (microseconds, same as spawntime)
ints["inWater"]               → 1 if player drowned
ints["InUse"]                 → 1 if another player is looting it
ints["addedDefaultItems"]     → 1 if tombstone has been opened
```

**Tombstone inventory format:** IDENTICAL to chest inventory (Base64 ZPackage, version 106)
→ Use the SAME `parseInventoryManual()` method already built
→ Exposes what player was carrying when they died
→ Admin use: find uncollected tombstones with valuable loot

**API addition for tombstone endpoint:**
```json
{
  "id": "...",
  "ownerName": "Jeraeldo",
  "ownerId": 593949588,
  "x": -1963.5, "z": -9284.5,
  "timeOfDeathSeconds": 75636518.4,
  "worldFraction": 0.708,
  "inWater": false,
  "looted": true,
  "items": [
    {"name": "CharredBone", "stack": 2, "quality": 3},
    {"name": "Coins",       "stack": 9, "quality": 3},
    {"name": "Softtissue",  "stack": 1, "quality": 3}
  ]
}
```

---

## 5. PORTAL CONTRACT  ✅ LOCKED

**Prefab:** `portal_wood` (singular — confirmed only one portal type in this save)

**Properties:**
```
strings["tag"]        → routing tag (case-sensitive, empty = blank tag)
strings["author"]     → Steam_XXXXXXX of who BUILT the portal
strings["tagauthor"]  → Steam_XXXXXXX of who LAST SET the tag (may differ from builder)
strings["text"]       → display text shown above portal (decorative, may be empty)
longs["creator"]      → internal ID of builder
longs["target_u"]     → ZdoId UID of paired portal (0 = no pair set, orphaned)
longs["lastTime"]     → last used timestamp (microseconds)
```

**Portal pairing algorithm (use target_u FIRST):**
```
1. If target_u != 0: pair = ZDO with uid == target_u  (O(1) lookup, authoritative)
2. Fallback: find other portal with same tag AND that portal's target_u points back
3. If neither: ORPHANED
```

**IMPORTANT:** `target_u` = the UID field (uint32) of the paired ZdoId.
This is NOT the `longs["creator"]` value. It's the ZdoId.uid of the target ZDO.
During import, build: `Map<Long, Integer> zdoUidToArrayIndex` to resolve target_u lookups.

**Portal status enum:**
```
PAIRED      → target_u points to a valid portal with matching tag
ORPHANED    → target_u=0, no other portal with same non-empty tag exists
HUB         → 3+ portals share the same tag (note: Valheim only connects 2; extras = broken)
BLANK_TAG   → tag="" or tag is whitespace only
MISMATCH    → target_u points to wrong tag (e.g., tag was changed after pairing)
```

---

## 6. TCDATA CONTRACT  ✅ LOCKED

**Both hash:-494364525 (containers) and hash:650075310 (item stands) use gzip:**

```
TCData bytes = GZIPInputStream(byte[])
First bytes: 1f 8b 08 00  (gzip magic header confirmed on ALL samples)
```

**Decompression approach (Java):**
```java
static byte[] decompressTCData(byte[] compressed) throws IOException {
    try (GZIPInputStream gz = new GZIPInputStream(new ByteArrayInputStream(compressed));
         ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buf = new byte[4096];
        int n;
        while ((n = gz.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
// Then: ZPackage pkg = new ZPackage(decompressTCData(tcData));
// Parse the decompressed bytes as a new ZPackage
```

**NEXT STEP (still needed before Container API launch):**
Run `TCDataDecoder2.java` — decompress the TCData and parse the inner ZPackage to determine the format. Expected: inventory blob (same format as strings["items"]) or item-stand state.

---

## 7. WORLD BOUNDS CONTRACT  ✅ LOCKED

**Sentinel filtering required:**
Some ZDOs have position `(1e9, *, 1e9)` = invalid/unplaced objects. Filter before rendering.

```
VALID_POSITION filter: Math.abs(x) < 100_000 && Math.abs(z) < 100_000
```

**Actual world bounds (from valid ZDOs):**
```
x: [-25,792, ~25,000]  (approximately symmetric)
z: [-20,000, +26,626]  (asymmetric: Ashlands extends further south in this seed)
y: [-5,100, +5,538]    (elevation, not used for 2D map)
```

**Leaflet viewport setup:**
```javascript
const WORLD_BOUNDS = L.latLngBounds(
  [-20500, -26500],  // southwest [z_min, x_min]
  [ 27500,  26500]   // northeast [z_max, x_max]
);
const map = L.map('map', { crs: L.CRS.Simple });
map.fitBounds(WORLD_BOUNDS);

// Coordinate helpers — always use these, never inline:
function worldToLatLng(x, z) { return L.latLng(z, x); }  // z=lat, x=lng
function latLngToWorld(ll)    { return { x: ll.lng, z: ll.lat }; }
```

---

## 8. ZDO IDENTITY CONTRACT  ✅ LOCKED

**ZdoId = (userId: long, uid: uint32)**
- `userId` = the "owner" client's internal session ID (server's `myId` for world ZDOs)
- `uid` = sequential 32-bit counter per client

**Storage requirement:** Store both fields for every ZDO during import for delta tracking.

**Serialization:** Composite key as string `"{userId}:{uid}"` for API responses.

**Dead ZDO count:** 0 in this save (confirmed by DeepProbe). Parser reads the dead ZDO section correctly.

---

## 9. ITEM NAME CONTRACT  ✅ LOCKED

**Format: bare PascalCase names (NOT `$item_*` localization keys)**

```
Examples: "Wood", "IronOre", "BronzeNails", "SwordBlackmetal", "CapeLox"
Edge cases:
  - Mod items: may use any naming convention (detect by unknown hash or extra customData)
  - Unresolved dropped items: display as "hash:109649212" (never suppress)
  - Empty name: filter out (inventory parse artifact)
```

**Localization file:** NOT needed for items. Items store their internal name.
Localization needed for: display name cleanup (`"IronOre"` → `"Iron Ore"`) — optional UX polish only.

---

## 10. CATEGORY TAXONOMY CONTRACT  ✅ LOCKED

```
CATEGORY        DETECTION RULE                          COUNT ESTIMATE
──────────────────────────────────────────────────────────────────────
NATURE          no creator + no crafterName              ~5.5M ZDOs
BUILDING        hasCreator + (hasSupport || hasHealth)   ~2.2M ZDOs
DROPPED_ITEM    hasCrafterName + hasSpawntime + hasStack  ~192k ZDOs
ITEM_STAND      has strings["item"] + hasCreator          ~375k ZDOs
CONTAINER       has strings["items"] || has TCData        ~130k ZDOs
CREATURE        prefab in KNOWN_CREATURES set             ~52k ZDOs
PORTAL          prefab == "portal_wood"                   9,135 ZDOs
BED             prefab in {"bed","piece_bed02"}           1,968 ZDOs
TOMBSTONE       prefab == "Player_tombstone"              613 ZDOs
SIGN            prefab in {"sign","sign_notext"}          221k ZDOs
              + hash == 686545676 (confirmed sign variant)
BALLISTA        hash == -1195767551                       40k ZDOs
UNKNOWN         none of the above                        classify by hash
```

**Unknown hash classification by property signature:**
```
hash + health + support + creator → BUILDING (unresolved building piece name)
hash + health + creator + stack + quality (no item string) → ITEM_STAND (empty)
hash + health + creator + TCData → CONTAINER
hash + health + creator (only) → BUILDING or UNKNOWN_STRUCTURE
hash + scaleScalar → NATURE (vegetation with scale variation)
hash + (nothing) → NATURE (pure terrain marker)
```

---

## REMAINING WORK BEFORE BUILDING

### HARD BLOCKER
- [ ] **TCData inner format** — decompress gzip and parse inner ZPackage to determine if it's an inventory. Write `TCDataDecoder2.java`. Do NOT launch Container API until resolved.

### IMPORTANT (do before Player features)
- [ ] **Spawntime > netTime edge cases** — decide API behavior: clamp to 1.0? expose raw fraction? Current decision: expose raw, client handles display.
- [ ] **Portal target_u resolution** — confirm `target_u` stores UID (not full ZdoId). Test: find a paired portal, check `target_u` value matches the partner's `uid` field from the library.

### NICE TO HAVE (non-blocking)
- [ ] **Unresolved Ashlands drops** — try Ashlands item names from community wiki data
- [ ] **hash:538325542 building piece name** — building heatmap works without it; label as "Unknown Building Piece #538325542"

---

## API VERSION HEADER

All responses include:
```json
{
  "apiVersion": "1.0",
  "schemaVersion": 1,
  "snapshotNetTime": 10687829.1,
  ...
}
```

`schemaVersion` increments on any breaking change. Clients MUST check this before processing.
