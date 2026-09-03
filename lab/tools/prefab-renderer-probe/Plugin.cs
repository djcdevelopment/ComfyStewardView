using BepInEx;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace Steward.PrefabRendererProbe
{
    [BepInPlugin("dev.steward.prefab-renderer-probe", "Steward Prefab Renderer Probe", "1.0.0")]
    public sealed class Plugin : BaseUnityPlugin
    {
        private const float MinimumAxis = 0.02f;
        private const int MaximumBoxes = 32;
        private bool _written;

        private void Awake()
        {
            StartCoroutine(WaitForPrefabs());
            Logger.LogInfo("Steward renderer probe armed; it writes bounds only, never meshes or materials.");
        }

        private IEnumerator WaitForPrefabs()
        {
            while (!_written)
            {
                if (ZNetScene.instance != null && ZNetScene.instance.m_prefabs != null &&
                    ZNetScene.instance.m_prefabs.Count > 100)
                {
                    WriteReceipt();
                    _written = true;
                    yield break;
                }
                yield return new WaitForSeconds(1f);
            }
        }

        private void WriteReceipt()
        {
            var rows = new List<PrefabReceipt>();
            foreach (var prefab in ZNetScene.instance.m_prefabs.Where(value => value != null)
                         .OrderBy(value => value.name, StringComparer.Ordinal))
            {
                rows.Add(ReadPrefab(prefab));
            }

            var body = new StringBuilder();
            body.Append("{\n  \"schema\": \"steward-prefab-renderers/v1\",\n");
            body.Append("  \"gameVersion\": ").Append(Json(GameVersion())).Append(",\n");
            body.Append("  \"generatedAt\": ").Append(Json(DateTimeOffset.UtcNow.ToString("O"))).Append(",\n");
            body.Append("  \"contract\": \"LOD0 renderer bounds and prefab-local transforms only; no meshes, materials, textures, particles, trails, lines, colliders, or lower-LOD duplicates\",\n");
            body.Append("  \"prefabs\": [\n");
            for (var i = 0; i < rows.Count; i++)
            {
                if (i > 0) body.Append(",\n");
                body.Append(rows[i].Json("    "));
            }
            body.Append("\n  ]\n}\n");

            var path = Path.Combine(Paths.ConfigPath, "steward-prefab-renderers.json");
            File.WriteAllText(path, body.ToString(), new UTF8Encoding(false));
            Logger.LogInfo($"Wrote {rows.Count:n0} prefab renderer receipts to {path}");
        }

        private static PrefabReceipt ReadPrefab(GameObject prefab)
        {
            var windmill = prefab.GetComponent<Windmill>();
            var propeller = windmill != null ? windmill.m_propeller : null;
            var lod0 = new HashSet<Renderer>();
            var lowerLod = new HashSet<Renderer>();
            foreach (var group in prefab.GetComponentsInChildren<LODGroup>(true))
            {
                var levels = group.GetLODs();
                if (levels.Length > 0)
                    foreach (var renderer in levels[0].renderers.Where(value => value != null)) lod0.Add(renderer);
                for (var level = 1; level < levels.Length; level++)
                    foreach (var renderer in levels[level].renderers.Where(value => value != null)) lowerLod.Add(renderer);
            }

            var boxes = new List<BoxReceipt>();
            foreach (var renderer in prefab.GetComponentsInChildren<Renderer>(true))
            {
                if (!(renderer is MeshRenderer) && !(renderer is SkinnedMeshRenderer)) continue;
                if (!ActiveUnderRoot(prefab.transform, renderer.transform)) continue;
                if (lowerLod.Contains(renderer) && !lod0.Contains(renderer)) continue;
                if (renderer.GetComponent<ParticleSystemRenderer>() != null || renderer is TrailRenderer || renderer is LineRenderer) continue;

                Bounds bounds;
                var skinned = renderer as SkinnedMeshRenderer;
                if (skinned != null) bounds = skinned.localBounds;
                else
                {
                    var filter = renderer.GetComponent<MeshFilter>();
                    if (filter == null || filter.sharedMesh == null) continue;
                    bounds = filter.sharedMesh.bounds;
                }
                if (bounds.size.x < MinimumAxis || bounds.size.y < MinimumAxis || bounds.size.z < MinimumAxis) continue;

                var local = prefab.transform.worldToLocalMatrix * renderer.transform.localToWorldMatrix *
                    Matrix4x4.TRS(bounds.center, Quaternion.identity, bounds.size);
                if (!Finite(local)) continue;
                var path = RelativePath(prefab.transform, renderer.transform);
                var animated = propeller != null &&
                    (renderer.transform == propeller || renderer.transform.IsChildOf(propeller));
                var receipt = new BoxReceipt(path, local, animated);
                if (!boxes.Any(existing => existing.NearlyEquals(receipt))) boxes.Add(receipt);
            }
            boxes.Sort((a, b) => StringComparer.Ordinal.Compare(a.Path, b.Path));
            Vector3? animationPivot = null;
            if (propeller != null) animationPivot = prefab.transform.InverseTransformPoint(propeller.position);
            return new PrefabReceipt(prefab.name, prefab.name.GetStableHashCode(), boxes,
                boxes.Count == 0 ? "empty" : boxes.Count > MaximumBoxes ? "too-many-boxes" : "candidate",
                animationPivot);
        }

        private static bool ActiveUnderRoot(Transform root, Transform value)
        {
            for (var cursor = value; cursor != null; cursor = cursor.parent)
            {
                if (cursor == root) return true;
                if (!cursor.gameObject.activeSelf) return false;
            }
            return false;
        }

        private static string GameVersion()
        {
            try
            {
                var type = typeof(ZNet).Assembly.GetType("Version");
                var method = type?.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                    .FirstOrDefault(value => value.Name == "GetVersionString" && value.ReturnType == typeof(string));
                if (method != null)
                {
                    var parameters = method.GetParameters();
                    var result = parameters.Length == 0 ? method.Invoke(null, null) :
                        parameters.Length == 1 && parameters[0].ParameterType == typeof(bool)
                            ? method.Invoke(null, new object[] { false }) : null;
                    if (result is string text && !string.IsNullOrWhiteSpace(text)) return text;
                }
            }
            catch { }
            return Application.version;
        }

        private static string RelativePath(Transform root, Transform value)
        {
            var names = new Stack<string>();
            for (var cursor = value; cursor != null && cursor != root; cursor = cursor.parent) names.Push(cursor.name);
            return names.Count == 0 ? "." : string.Join("/", names.ToArray());
        }

        private static bool Finite(Matrix4x4 matrix)
        {
            for (var row = 0; row < 4; row++)
                for (var column = 0; column < 4; column++)
                    if (float.IsNaN(matrix[row, column]) || float.IsInfinity(matrix[row, column])) return false;
            return true;
        }

        private static string Json(string value)
        {
            if (value == null) return "null";
            var outValue = new StringBuilder("\"");
            foreach (var ch in value)
            {
                switch (ch)
                {
                    case '\\': outValue.Append("\\\\"); break;
                    case '\"': outValue.Append("\\\""); break;
                    case '\n': outValue.Append("\\n"); break;
                    case '\r': outValue.Append("\\r"); break;
                    case '\t': outValue.Append("\\t"); break;
                    default: outValue.Append(ch < 32 ? $"\\u{(int)ch:x4}" : ch.ToString()); break;
                }
            }
            return outValue.Append('\"').ToString();
        }

        private static string Number(float value) => value.ToString("R", CultureInfo.InvariantCulture);

        private sealed class PrefabReceipt
        {
            private readonly string _name;
            private readonly int _hash;
            private readonly List<BoxReceipt> _boxes;
            private readonly string _status;
            private readonly Vector3? _animationPivot;
            public PrefabReceipt(string name, int hash, List<BoxReceipt> boxes, string status,
                Vector3? animationPivot)
            { _name = name; _hash = hash; _boxes = boxes; _status = status; _animationPivot = animationPivot; }

            public string Json(string indent)
            {
                var body = new StringBuilder();
                body.Append(indent).Append("{\"name\":").Append(Plugin.Json(_name))
                    .Append(",\"hash\":").Append(_hash)
                    .Append(",\"status\":").Append(Plugin.Json(_status))
                    .Append(",\"boxCount\":").Append(_boxes.Count);
                if (_animationPivot.HasValue)
                {
                    var pivot = _animationPivot.Value;
                    body.Append(",\"animationAxis\":\"z\",\"animationPivot\":[")
                        .Append(Number(pivot.x)).Append(',').Append(Number(pivot.y)).Append(',')
                        .Append(Number(pivot.z)).Append(']');
                }
                body.Append(",\"boxes\":[");
                for (var i = 0; i < _boxes.Count; i++)
                {
                    if (i > 0) body.Append(',');
                    body.Append('\n').Append(_boxes[i].Json(indent + "  "));
                }
                if (_boxes.Count > 0) body.Append('\n').Append(indent);
                return body.Append("]}").ToString();
            }
        }

        private sealed class BoxReceipt
        {
            public string Path { get; }
            private readonly Matrix4x4 _matrix;
            private readonly bool _animated;
            public BoxReceipt(string path, Matrix4x4 matrix, bool animated)
            { Path = path; _matrix = matrix; _animated = animated; }

            public bool NearlyEquals(BoxReceipt other)
            {
                for (var row = 0; row < 4; row++)
                    for (var column = 0; column < 4; column++)
                        if (Math.Abs(_matrix[row, column] - other._matrix[row, column]) > 0.0001f) return false;
                return true;
            }

            public string Json(string indent)
            {
                var body = new StringBuilder(indent).Append("{\"path\":").Append(Plugin.Json(Path))
                    .Append(",\"animated\":").Append(_animated ? "true" : "false").Append(",\"matrix\":[");
                // JSON is column-major, matching Unity Matrix4x4 and the scene instance record.
                for (var column = 0; column < 4; column++)
                    for (var row = 0; row < 4; row++)
                    {
                        if (column != 0 || row != 0) body.Append(',');
                        body.Append(Number(_matrix[row, column]));
                    }
                return body.Append("]}").ToString();
            }
        }
    }
}
