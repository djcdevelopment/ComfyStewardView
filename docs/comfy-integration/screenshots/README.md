# Screenshots

The five screenshots that document the integrated UI live in this folder. They were captured at 2026-05-26 against the patched daemon on `localhost:7080`.

Suggested filenames + what each shows:

| File | Tab | What it demonstrates |
|---|---|---|
| `01-map.png` | 🗺 Map | Leaflet world map with the building heatmap and container point overlay enabled. Cyan dots = chests; warmer cells = denser ZDO clusters. Major bases visible in the north (z>10000) and east (x>5000). |
| `02-portals.png` | 🌀 Portals | Tabulator grid of all 9,135 portals with PAIRED / ORPHANED / HUB / BLANK_TAG status. Search box filters by tag, status buttons filter by status. Columns: Tag, Status, X, Z, Paired X, Paired Z, Author. |
| `03-economy.png` | 💰 Economy | The PA3 enhancement live. "By Category" chip row shows Material 5.8M, Currency 4.4M, Food 2.2M, Ammo 713K, etc. "By Progression Tier" chips show tier0 through tier7 totals. Each top-item bar shows item name + category · tier · count. |
| `04-server-issuers.png` | 👑 Server Issuers | The PA5 forensics in action. Rendered HTML for each issuer name (colored "Luna Lady Galadriel", bold "Best West Reward", multi-color "Comfy Era XIV", etc.). 337 distinct issuers visible. Click → drills to Guild Gear. |
| `05-guild-gear.png` | 🎁 Guild Gear | "Dark Rab ⚔ Arisen from the Ashes E14" issuer selected. Shows 281 items, 35 distinct types, with category + tier · biome enrichment from our classification. Useful for confirming a reward economy works as intended. |

## How to save the screenshots

The user captured these in their browser at session end. To file them here:

1. Save the original screenshot PNGs from your screen-capture tool / clipboard into this folder using the filenames above.
2. Or use Windows Snipping Tool against `http://localhost:7080/`:
   - Map tab → save as `01-map.png`
   - Portals tab → save as `02-portals.png`
   - Economy tab → save as `03-economy.png`
   - Server Issuers tab → save as `04-server-issuers.png`
   - Guild Gear tab (select "Dark Rab" issuer) → save as `05-guild-gear.png`

The README.md in the parent folder references these by name; they'll render in any markdown viewer that supports relative image paths.
