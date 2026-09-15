# Gallery capture composer

Steward owns the shared photography workspace at `/capture.html?photo=<id>` and its
versioned JavaScript/CSS artifact. Studio embeds those exact bytes in Creator/DM's
Capture mode. A photograph selects its archived build; edits affect only the capture
composition. Gameplay target selection keeps its existing private membership and limits.

The capture bar supports position/aim, 90°/65°/35° **vertical** lenses, 16:9/1:1/9:16
frames, and 1920/3840 longest edges. Recorded FOV is preserved on load. Lens and Outside
keep separate camera state. The yellow projection, geometry picks, person marker and
live preview use the same camera model. The visible scene contains archived piece boxes;
terrain, vegetation and game rendering can differ. Coverage is explicitly an estimate.

Camera state is `selfiestick-camera/v1`: absolute lens xyz, yaw, downward pitch, roll,
vertical FOV, output width/height and target distance. Mirrored scene X is converted
only at the renderer boundary. Resize and observer controls do not change export state.
Unity's FOV is vertical ([camera reference](https://docs.unity3d.com/ScriptReference/Camera-fieldOfView.html));
aspect ratio determines horizontal coverage. Published `camera-fixtures.json` is checked
by Java, JavaScript and SelfieStick through the explicit artifact boundary.

## Use the composer

From a gallery photograph's detail view, choose **Compose**. In Creator/DM choose
**Capture**; it mounts the same workspace through Studio's pinned copy. The Gallery
control chooses another archived build and reference photograph. The reference stays
as a thumbnail, and its recorded field of view is kept until the user selects a new
lens. A photograph with incomplete pose or world identity stays browsable and shows
the missing prerequisite. Composition and download controls are unavailable when
the needed scene or local-replay metadata is missing.

The bar is a keyboard-accessible toolbar; each control has a short label and tooltip:

| Control | What it changes |
| --- | --- |
| Position / Aim | Edit lens X, elevation and Z numerically, pick a standing point or aim point on available geometry, or drag the yellow handles in Outside view. |
| Lens | Wide 90°, Normal 65° or Telephoto 35° vertical field of view. |
| Frame and Size | Landscape 16:9, Square 1:1 or Portrait 9:16; 1,920 or 3,840 pixels on the longest edge. |
| Lens / Outside | Lens edits the capture camera; Outside orbits an independent observer and shows the camera, player-scale marker and live lens preview. `V` switches views. |
| Coverage | Show or hide the yellow pyramid and target-distance frame. `C` toggles it without changing the camera. |
| Reset / Download | `R` restores the reference composition; Download packages one still for local Windows/Linux execution. |

In Lens view, drag to look, use WASD to move, Q/E for elevation and Shift for faster
travel. In Outside view, drag to orbit and use the wheel to zoom. The viewport can be
resized and views switched repeatedly without changing the exported lens. Projection
guides are estimates from piece envelopes, not a promise of exact game occlusion.
If WebGPU cannot create the scene, the workspace explains that state and disables
download rather than exporting an uninspected composition. Once the proof gate is
enabled for the exact runner, Download supplies `capture.json`, a shot list,
reference thumbnail, runner dependencies and both launchers. The
[SelfieStick instructions](https://github.com/djcdevelopment/SelfieStick/blob/main/runner/README.md)
cover the local PNG and restoration receipt.

## Data and downloads

`tools/era-archive/capture_catalog.py` projects `steward-capture-catalog/v1` from gallery
manifests plus exact archive inventory. It retains hosted image derivatives, source
identity, original pose/settings and scene references. Missing pose or world metadata
leaves a photograph browsable with an availability reason. Missing lighting permits
composition when the scene is available, but disables local replay.

The active gallery producer, `build_era_index.py`, accepts `--capture-archive` and
writes `capture-catalog.json` beside `index.json`. It selects the largest available
version of a photograph. Its existing `--world-url` supplies the lightbox's Compose
link. The second-pass branch's older index producer can emit the same catalog when
that branch is integrated; `build_era_index.py` is the producer in this `main` cut.

- `GET /api/captures`: catalog and computed download availability.
- `GET /api/captures/{id}`: reference details.
- `GET /api/captures/{id}/scene`: the matching read-only archived SV3D scene.
- `POST /api/captures/{id}/export`: JSON `{ "camera": ... }`; source and lighting come
  from the server's catalog. The response is a deterministic ZIP.

Set `STEWARD_CAPTURE_ROOT` to a deployment prepared by
`tools/era-archive/package_capture.py`. Supply explicit `--catalog`, `--runner-release`,
`--runner`, `--proof` (once per host), and a fresh `--out` directory. It fetches existing
hosted thumbnails, verifies transferred byte counts and SHA-256, and records a deployment
manifest. Without a root the empty catalog remains available.

Downloads require the pinned SelfieStick 0.3.1 runner and matching OMEN/AM4 receipts.
The server checks receipt and PNG hashes, measured lens/orientation/FOV/dimensions,
local disposable save identity, unchanged save fingerprints, camera restoration, and
the entire runner manifest. A catalog boolean or a summary claiming success cannot
enable downloads. Test candidates with incomplete proof remain browse-only.

The ZIP includes the specification, generated shot list, reference WebP, both launchers,
runner source and pinned DLLs. The archive world, Valheim installation and character
are supplied locally by the user; results stay local.

## Candidate boundary and verification

Build the UI with `python tools/package_capture_composer.py --out <new-artifact.zip>`.
Studio's importer takes that ZIP and its pin explicitly. The manifest records every
asset's bytes/hash plus the base source revision and `candidate: true`; local candidate
bytes include working changes and are not a claim of a published clean revision.
The raw browser assets are pinned to LF checkout in `.gitattributes`, including the
existing scene renderer. Verify the package from a fresh Windows checkout before
promoting its hash.

Run the lab Maven tests, `node lab/tools/camera-model.test.mjs`, capture-catalog Python
tests, and the two browser tools in `lab/tools/`. Browser tools take an explicit
`--playwright` module and output directory. The integration tool also takes running
`--gallery` and `--studio` URLs and checks identical download bytes plus Studio's token
boundary. It uses installed Chrome with WebGPU.

See `docs/evidence/gallery-capture-20260915.json` for candidate hashes and measured
evidence. These are prepared local candidates; the public deployment was not changed.

## Why this boundary and what follows

Steward already owns the gallery's images, archive identity and scene projection. One
composer here gives the public gallery and Studio identical camera geometry and
one deterministic export. Studio retains Creator/DM authentication and gameplay
targeting; the archive is read-only photographic context. SelfieStick owns Valheim's
real camera and save lifecycle, so Steward accepts only measured runner proof rather
than treating its browser estimate as a finished picture.

After the source landing, rebuild the composer from a pushed revision, pin that
release in Studio and stage the exact runner plus real OMEN/AM4 PNG and restoration
receipts before public downloads are enabled. The cross-repository
[program plan](https://github.com/djcdevelopment/baseline/blob/main/docs/gallery-capture-program-plan.md)
tracks that cut. Moving-camera capture needs a time-sampled contract and game proof;
video, panorama, fisheye, aperture simulation and applying shots to unrelated worlds
are outside this still release.
