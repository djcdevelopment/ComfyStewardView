# Prefab renderer probe

This private R&D probe runs inside the locally installed Valheim client and records only LOD0 renderer bounds and transforms. It does not copy meshes, materials, textures, colliders, particle systems, trails, or line renderers.

Build with the installed game assemblies:

```powershell
dotnet build -c Release -p:ValheimDir='C:\Program Files (x86)\Steam\steamapps\common\Valheim'
```

Place `StewardPrefabRendererProbe.dll` under `BepInEx/plugins/StewardPrefabRendererProbe/`, start Valheim, and wait at the main menu. The receipt is written to `BepInEx/config/steward-prefab-renderers.json` with schema `steward-prefab-renderers/v1`.

Promotion is a separate, metrics-gated step. A probe candidate is rejected when it has no boxes or more than 32 boxes; the public scene never reads this private receipt directly.
