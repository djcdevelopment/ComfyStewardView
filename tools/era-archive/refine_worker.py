#!/usr/bin/env python3
"""Shoot, judge on the CPU, move the camera, shoot again -- inside one game session.

The campaign worker pays a ~3 minute world load per attempt and hands its masters to a
pipeline that measures them days later on another host. This worker launches the client
ONCE in ComfyCameraProof's feed mode (0.2.3+), then feeds it one small shotplan at a time:
the planned pose of a build, a fan of candidate poses around it, and if one of those wins,
a second fan around the winner. Every master is judged on this host's CPU about a second
after the shutter (frame_judge) and the paired compare decides the next move. A fed row
costs ~7 s; nothing leaves the host.

v2 (after reading all 47 frames of the first slice): the receipt and the first frame gate
the fan. A build whose aim is off its mass (pieces_near_aim below the floor), sits in
Mistlands mist, or aims at sky gets no orbit/elevation/distance fan -- those are the
planner's problems, journalled as `needs` -- and at most one re-aim toward where the
texture actually is. The fan gains `up20` (the top-down the occlusion ladder found by
accident) and `c75` is offered once per build and only while the frame is under-filled:
closer twice walks into texture resolution.

    ~/venvs/torch-xpu/bin/python refine_worker.py --prepare --root R --from-root V5 --framing F --builds 8
    python3 install_capture_worker.py --root R ...      # freezes runtime.json; single-use root
    ~/venvs/torch-xpu/bin/python refine_worker.py --root R --builds 8 --rounds 2 --threads 8

Receipts: refine-journal.jsonl (every launch/plan/judgement/decision), refine.json (the
winner per build with its pose, metrics and `needs`), refine-summary.md, plus the masters
under images/<run>/ and the usual state.json journal. Nothing here imports, derives or
publishes.
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from capture_worker import HEADER, Worker, read, write   # noqa: E402

FEED_DIR = 'shotplan-feed'
MOVES = {
    'o45': 'orbit +45 deg about the aim, same distance and elevation',
    'lo12': 'elevation -12 deg, same distance (floor instead of sky)',
    'up20': 'elevation +20 deg, same distance (the top-down the ladder found by accident)',
    'c75': 'distance x0.75, same bearing (min 6 m); once per build, only while under-filled',
    'aim': 're-aim toward the live-tile centroid; same camera position',
}
FAN = ('o45', 'lo12', 'up20')
CLOSER_LIVE_MAX = 0.35       # c75 only while liveTileShare is below this
REAIM_MIN_OFFSET = 0.15      # re-aim only when the texture centroid is this far from centre (frame units)
DUPLICATE_M = 1.0            # two candidates placed within this are the same photograph
FOV_V_DEG = 65.0             # Camera.main.fieldOfView; the receipt carries the live value


# ---- pose math: pure trig from the incumbent's receipt, the inverse of plan_shots.camera_for
def look_angles(cam, aim):
    """Unity convention, as plan_shots.camera_for: yaw clockwise from +Z, pitch positive DOWN."""
    dx, dy, dz = aim[0] - cam[0], aim[1] - cam[1], aim[2] - cam[2]
    n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
    yaw = math.degrees(math.atan2(dx, dz)) % 360.0
    pitch = math.degrees(-math.asin(max(-1.0, min(1.0, dy / n))))
    return round(yaw, 2), round(pitch, 2)


def forward(yaw_deg, pitch_deg):
    """Unit view direction for Unity yaw/pitch (pitch positive = down)."""
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    return (math.sin(y) * math.cos(p), -math.sin(p), math.cos(y) * math.cos(p))


def pose_from_receipt(receipt):
    """lens is the true camera; placed is the player's feet the TSV positions. Keep the offset."""
    lens = receipt['lens']; aim = receipt['aim']; placed = receipt['placed']
    L = (lens['x'], lens['y'], lens['z']); A = (aim['x'], aim['y'], aim['z'])
    off = (lens['x'] - placed['x'], lens['y'] - placed['y'], lens['z'] - placed['z'])
    v = (L[0] - A[0], L[1] - A[1], L[2] - A[2])
    horiz = math.hypot(v[0], v[2])
    return {'lens': L, 'feet': (placed['x'], placed['y'], placed['z']), 'aim': A, 'offset': off,
            'distance': math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2),
            'azimuth': math.atan2(v[0], v[2]), 'elevation': math.atan2(v[1], horiz),
            'yaw': receipt.get('yaw'), 'pitch': receipt.get('pitch'), 'fov': receipt.get('fov') or FOV_V_DEG}


def place(pose, azimuth, elevation, distance):
    A, off = pose['aim'], pose['offset']
    lens = (A[0] + distance * math.cos(elevation) * math.sin(azimuth),
            A[1] + distance * math.sin(elevation),
            A[2] + distance * math.cos(elevation) * math.cos(azimuth))
    feet = (lens[0] - off[0], lens[1] - off[1], lens[2] - off[2])
    yaw, pitch = look_angles(feet, A)
    return {'cam': tuple(round(c, 1) for c in feet), 'aim': tuple(round(c, 1) for c in A),
            'yaw': yaw, 'pitch': pitch, 'azimuth_deg': round(math.degrees(azimuth) % 360, 1),
            'elevation_deg': round(math.degrees(elevation), 1), 'distance_m': round(distance, 1)}


def reaim(pose, centroid_x, centroid_y, crop_bottom=0.93):
    """Same camera, turned toward the live-tile centroid. Centroid coords are in the HUD-cropped
    frame (top 93 %); pitch positive = down, image y grows downward, so the signs agree."""
    fov_v = math.radians(pose['fov'])
    fov_h = 2 * math.atan(math.tan(fov_v / 2) * 16 / 9)
    cy_full = centroid_y * crop_bottom
    d_yaw = math.degrees(math.atan((centroid_x - 0.5) * 2 * math.tan(fov_h / 2)))
    d_pitch = math.degrees(math.atan((cy_full - 0.5) * 2 * math.tan(fov_v / 2)))
    yaw = round((pose['yaw'] + d_yaw) % 360, 2); pitch = round(pose['pitch'] + d_pitch, 2)
    f = forward(yaw, pitch); d = pose['distance']; L = pose['lens']
    aim = (L[0] + d * f[0], L[1] + d * f[1], L[2] + d * f[2])
    return {'cam': tuple(round(c, 1) for c in pose['feet']), 'aim': tuple(round(c, 1) for c in aim),
            'yaw': yaw, 'pitch': pitch, 'azimuth_deg': None, 'elevation_deg': None, 'distance_m': round(d, 1),
            'd_yaw': round(d_yaw, 1), 'd_pitch': round(d_pitch, 1)}


def candidate_poses(receipt, metrics, moves):
    pose = pose_from_receipt(receipt)
    az, el, d = pose['azimuth'], pose['elevation'], pose['distance']
    out = []
    for move in moves:
        if move == 'o45':
            out.append((move, place(pose, az + math.radians(45), el, d)))
        elif move == 'lo12':
            out.append((move, place(pose, az, max(math.radians(3), el - math.radians(12)), d)))
        elif move == 'up20':
            out.append((move, place(pose, az, min(math.radians(80), el + math.radians(20)), d)))
        elif move == 'c75':
            out.append((move, place(pose, az, el, max(6.0, 0.75 * d))))
        elif move == 'aim':
            m = (metrics or {}).get('master') or {}
            cx, cy = m.get('liveCentroidX'), m.get('liveCentroidY')
            if cx is not None and pose['yaw'] is not None:
                out.append((move, reaim(pose, cx, cy)))
    return pose, out


def tsv_row(cid, name, cam, yaw, pitch, aim, label):
    return '\t'.join(str(x) for x in (cid, name, cam[0], cam[1], cam[2], yaw, pitch, 'Clear', 0.64,
                                       aim[0], aim[1], aim[2], label, '', 0, ''))


def shot_key(source_key, build_key, shot_name):
    return hashlib.sha256(f'{source_key}:{build_key}:{shot_name}'.encode()).hexdigest()


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


# ---- sample selection and the single-use root
def prepare(root, from_root, framing_path, n):
    """campaign.json = the source campaign's keys with builds cut to the N worst-framed shots."""
    root = Path(root); src = read(Path(from_root) / 'campaign.json'); framing = read(framing_path)['frames']
    by_cid = {b['localClusterId']: b for b in src['builds']}
    chosen, sample = {}, []
    for key, m in sorted(framing.items(), key=lambda kv: kv[1].get('liveTileShare', 1.0)):
        cid_text, _, shot_name = key.partition('_')
        try:
            cid = int(cid_text)
        except ValueError:
            continue
        build = by_cid.get(cid)
        if build is None or build['buildKey'] in chosen:
            continue
        shot = next((s for s in build['shots'] if s['shot'] == shot_name), None)
        if shot is None:
            continue
        chosen[build['buildKey']] = {**{k: v for k, v in build.items() if k != 'shots'}, 'shots': [shot]}
        sample.append({'buildKey': build['buildKey'], 'localClusterId': cid, 'shot': shot_name,
                       'framingKey': key, 'liveTileShare': m.get('liveTileShare'), 'detailTop10': m.get('detailTop10')})
        if len(chosen) >= n:
            break
    if len(chosen) < n:
        raise ValueError(f'only {len(chosen)} of {n} sample builds resolved against {from_root}')
    write_campaign(root, src, list(chosen.values()), {'fromRoot': str(Path(from_root).resolve()),
                                                       'framing': str(Path(framing_path).resolve()), 'sample': sample})
    print(f'prepared {len(chosen)} builds in {root}')
    for s in sample:
        print(f"  {s['framingKey']:<18} live {s['liveTileShare']:.3f}  {s['buildKey'][:8]}")


def prepare_all(root, from_root):
    """campaign.json = every build of the source campaign, first shot each (the full detail tier)."""
    root = Path(root); src = read(Path(from_root) / 'campaign.json')
    builds = [{**{k: v for k, v in b.items() if k != 'shots'}, 'shots': b['shots'][:1]} for b in src['builds'] if b['shots']]
    write_campaign(root, src, builds, {'fromRoot': str(Path(from_root).resolve()), 'sample': 'all-first-shots'})
    print(f'prepared {len(builds)} builds in {root}')


def read_json_stream(text):
    """Every JSON object in a file, one per line or pretty-printed across lines."""
    decoder = json.JSONDecoder(); pos = 0; out = []
    while True:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            return out
        entry, pos = decoder.raw_decode(text, pos)
        out.append(entry)


def prepare_requests(root, from_root, ledger_path):
    """campaign.json = the requested poses from a viewer ledger (steward-shot-request/v1), one
    shot per request, keyed to the source campaign's builds. The ledger row's cluster_id is a
    placeholder; the build's own local cluster id goes in its place so the receipts join."""
    root = Path(root); src = read(Path(from_root) / 'campaign.json')
    by_key = {b['buildKey']: b for b in src['builds']}
    builds, requests, skipped = {}, [], []
    for entry in read_json_stream(Path(ledger_path).read_text(encoding='utf-8-sig')):
        if entry.get('schema') != 'steward-shot-request/v1' or entry.get('era') != src['era']:
            skipped.append((entry.get('id'), 'wrong schema or era')); continue
        build = by_key.get(entry.get('build'))
        if build is None:
            skipped.append((entry.get('id'), 'build not in campaign')); continue
        fields = entry['tsv'].split('\t')
        if len(fields) < 12:
            skipped.append((entry.get('id'), 'short row')); continue
        fields[0] = str(build['localClusterId']); name = fields[1]
        record = builds.setdefault(build['buildKey'], {**{k: v for k, v in build.items() if k != 'shots'}, 'shots': []})
        record['shots'].append({'shotKey': shot_key(src['sourceKey'], build['buildKey'], name), 'shot': name,
                                'tsv': '\t'.join(fields),
                                'request': {k: entry.get(k) for k in ('id', 'at', 'requestedBy', 'note', 'camera')}})
        requests.append(entry['id'])
    if not builds:
        raise ValueError('no usable requests in the ledger' + (f' ({skipped})' if skipped else ''))
    write_campaign(root, src, list(builds.values()), {'fromRoot': str(Path(from_root).resolve()),
                                                       'ledger': str(Path(ledger_path).resolve()),
                                                       'requests': requests, 'skipped': skipped, 'mode': 'requests'})
    print(f'prepared {len(requests)} request(s) across {len(builds)} build(s) in {root}; skipped {len(skipped)}')


def write_campaign(root, src, builds, refine):
    plan = {k: v for k, v in src.items() if k != 'builds'}
    plan['builds'] = builds
    plan['createdAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    plan['refine'] = {**refine, 'moves': dict(MOVES), 'fan': list(FAN)}
    root.mkdir(parents=True, exist_ok=True)
    write(root / 'campaign.json', plan)
    (root / 'all-shots.tsv').write_text(HEADER + ''.join(s['tsv'] + '\n' for b in builds for s in b['shots']), encoding='utf-8')


class RefineWorker(Worker):
    def __init__(self, root, threads=8, idle_seconds=600):
        super().__init__(root)
        self.feed = self.cfg / FEED_DIR
        self.threads, self.idle_seconds = threads, idle_seconds
        self.journal_path = self.root / 'refine-journal.jsonl'
        self.counter = 0
        self.results = {}
        self.dest = None; self.saves = None; self.log = None; self.prefs = None
        self.t_start = time.monotonic()

    # ---- receipts
    def journal(self, event, **data):
        row = {'t': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'wall_s': round(time.monotonic() - self.t_start, 1),
               'event': event, **data}
        with self.journal_path.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(row) + '\n')
        print(f"[{row['wall_s']:7.1f}s] {event} " + ' '.join(f'{k}={v}' for k, v in data.items()
                                                             if k in ('name', 'rows', 'winner', 'reason', 'score', 'build', 'needs')), flush=True)

    def raw_receipts(self, keys):
        """Every receipt for these (cluster_id, shot) keys, skipped ones included -- the vetoes need them."""
        path = self.cfg / 'shotplan-receipts.jsonl'
        found = {}
        if not path.exists():
            return found
        for line in path.read_text(encoding='utf-8-sig', errors='replace').splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = (row.get('cluster_id'), row.get('shot'))
            if key in keys:
                found[key] = row
        return found

    # ---- the session
    def launch(self):
        self.check_runtime()
        self.feed.mkdir(parents=True, exist_ok=True)
        for p in self.feed.iterdir():          # a stale STOP or plan would end or replay the session
            if p.is_file():
                p.unlink()
        self.dest = self.root / 'runs' / 'refine-attempt-01'
        self.dest.mkdir(parents=True, exist_ok=False)
        self.saves, self.prefs = self.prepare_scratch(self.dest)
        for name in ('shotplan.tsv', 'shotplan-receipts.jsonl', 'orbit-request.json'):
            p = self.cfg / name
            if p.exists():
                shutil.copy2(p, self.dest / ('before-' + name))
        (self.cfg / 'shotplan.tsv').write_text(HEADER, encoding='utf-8')      # header only: everything is fed
        (self.cfg / 'shotplan-receipts.jsonl').write_text('', encoding='utf-8')
        write(self.cfg / 'orbit-request.json', {'world': self.plan['world'], 'character': self.runtime['character'],
                                                'quit_when_done': True, 'feed_dir': FEED_DIR,
                                                'feed_idle_seconds': self.idle_seconds})
        write(self.dest / 'dispatch.json', {'sourceKey': self.plan['sourceKey'], 'builds': self.plan['builds'],
                                            'runtimeMode': 'current-client', 'mode': 'refine'})
        self.state['activeAttempt'] = self.dest.relative_to(self.root).as_posix()
        write(self.root / 'state.json', self.state)
        # BepInEx recreates LogOutput.log at startup, but not before this worker's first poll:
        # a stale 'Feed: watching' from the previous session opened the feed at t+3 s once.
        stale = self.game / 'BepInEx/LogOutput.log'
        if stale.exists():
            stale.unlink()
        self.log = self.launch_game(self.dest)
        self.status('capturing', batch='refine', attempt=1)
        self.journal('launch', pid=self.process.pid)

    def game_alive(self):
        return self.process is not None and self.process.poll() is None

    def wait_world(self, timeout=900):
        """The mod logs 'Feed: watching' once the world is loaded and the (empty) initial plan is done."""
        log = self.game / 'BepInEx/LogOutput.log'
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            if not self.game_alive():
                raise RuntimeError('game exited before the world loaded')
            text = log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''
            if 'Feed: watching' in text:
                self.journal('world_ready', seconds_since_launch=round(time.monotonic() - t0, 1))
                return
            if 'Feed: idle timeout' in text or 'Caught fatal signal' in text:
                raise RuntimeError('game gave up before the feed opened')
            time.sleep(5)
        raise RuntimeError('world never became ready')

    def feed_plan(self, name, rows):
        tmp = self.feed / (name + '.tsv.tmp')
        tmp.write_text(HEADER + ''.join(r + '\n' for r in rows), encoding='utf-8')
        os.replace(tmp, self.feed / (name + '.tsv'))
        self.journal('plan_fed', name=name, rows=len(rows))

    def wait_plan(self, name, allowed, timeout):
        """Done when the mod renamed the plan .done; harvest what it produced. Skipped rows have no file."""
        done = self.feed / (name + '.tsv.done')
        t0 = time.monotonic()
        while True:
            self.harvest(self.read_receipts(allowed))
            if done.exists():
                self.harvest(self.read_receipts(allowed))
                break
            if not self.game_alive():
                raise RuntimeError(f'game exited during plan {name}')
            if time.monotonic() - t0 > timeout:
                raise RuntimeError(f'plan {name} did not finish within {timeout}s')
            time.sleep(2)
        receipts = self.raw_receipts(set(allowed))
        skipped = sorted(k[1] for k, r in receipts.items() if r.get('skipped'))
        self.journal('plan_done', name=name, plan_wall_s=round(time.monotonic() - t0, 1), receipts=len(receipts), skipped=skipped)
        self.status('capturing', batch='refine', attempt=1, plan=name)
        return receipts

    def judge_shot(self, judge, entry):
        """entry: {name, shotKey, receipt, [requested]}. Fills metrics/vetoes/score from the harvested master."""
        import frame_judge
        completed = self.state['completed'].get(entry['shotKey'])
        metrics = None
        if completed is not None:
            metrics = judge.measure(self.root / completed['file'])
            entry['file'] = completed['file']
        entry['metrics'] = metrics
        entry['vetoes'] = list(entry.get('vetoes') or []) + frame_judge.veto(entry['receipt'], metrics)
        entry['score'] = frame_judge.score(metrics) if metrics is not None and not entry['vetoes'] else None
        r = entry['receipt'] or {}
        placed_delta = None
        if entry.get('requested') and r.get('placed'):
            placed_delta = round(dist(entry['requested']['cam'], (r['placed']['x'], r['placed']['y'], r['placed']['z'])), 1)
        self.journal('judged', name=entry['name'], shotKey=entry['shotKey'], file=entry.get('file'),
                     requested=entry.get('requested'), placed_delta_m=placed_delta,
                     receipt={k: r.get(k) for k in ('run', 'plan', 'clearance', 'occluded', 'pieces_near_aim',
                                                    'lens', 'placed', 'aim', 'yaw', 'pitch', 'fov', 'skipped')} if entry['receipt'] else None,
                     master=metrics['master'] if metrics else None, geometry=metrics['geometry'] if metrics else None,
                     timings=metrics['timings'] if metrics else None, device=judge.device, threads=judge.threads,
                     vetoes=entry['vetoes'], score=entry['score'])
        return entry

    def next_plan_name(self, build_key, tag):
        self.counter += 1
        return f'{self.counter:04d}-{build_key[:8]}-{tag}'

    def gate(self, incumbent):
        """What the receipt and the first frame say the build needs before any fan is worth shooting."""
        v = incumbent['vetoes']; m = incumbent['metrics']
        if incumbent['receipt'] is None or incumbent['receipt'].get('skipped') or 'lens' not in incumbent['receipt']:
            return 'no-receipt', []
        if 'aim-off-mass' in v:
            return 'aim', []
        sky = ((m or {}).get('geometry') or {}).get('skyFraction') or 0.0
        if 'flat' in v and sky < 0.3:
            return 'demist', []
        if 'sky' in v:
            return 'sky', ['aim']
        return None, None

    def fan_moves(self, incumbent, c75_used):
        moves = list(FAN)
        m = (incumbent['metrics'] or {}).get('master') or {}
        if not c75_used and (m.get('liveTileShare') or 0.0) < CLOSER_LIVE_MAX:
            moves.append('c75')
        cx, cy = m.get('liveCentroidX'), m.get('liveCentroidY')
        if cx is not None and (abs(cx - 0.5) > REAIM_MIN_OFFSET or abs(cy * 0.93 - 0.5) > REAIM_MIN_OFFSET):
            moves.append('aim')
        return moves

    def request_build(self, judge, build):
        """A requested pose is the photographer's choice: shoot it, judge it (veto only), record it."""
        cid, key = build['localClusterId'], build['buildKey']
        for shot in build['shots']:
            allowed = {(cid, shot['shot']): shot}
            name = self.next_plan_name(key, 'rq')
            self.feed_plan(name, [shot['tsv']])
            receipts = self.wait_plan(name, allowed, timeout=240)
            entry = self.judge_shot(judge, {'name': shot['shot'], 'shotKey': shot['shotKey'],
                                            'receipt': receipts.get((cid, shot['shot']))})
            rid = (shot.get('request') or {}).get('id') or shot['shot']
            self.results[rid] = {'buildKey': key, 'localClusterId': cid, 'shot': shot['shot'], 'request': shot.get('request'),
                                 'file': entry.get('file'), 'shotKey': shot['shotKey'], 'vetoes': entry['vetoes'],
                                 'score': entry['score'],
                                 'pose': ({k: entry['receipt'].get(k) for k in ('lens', 'placed', 'aim', 'yaw', 'pitch', 'clearance')}
                                          if entry['receipt'] else None)}
            self.journal('decision', build=key[:8], round=0, incumbent=shot['shot'], winner=shot['shot'],
                         reason='requested pose' + (' (vetoed: ' + ','.join(entry['vetoes']) + ')' if entry['vetoes'] else ''),
                         candidates=[], needs=None, request=rid)
        write(self.root / 'requests-result.json', {'schema': 'steward-shot-requests-result/v1',
                                                   'sourceKey': self.plan['sourceKey'], 'era': self.plan['era'],
                                                   'requests': self.results})

    def refine_build(self, judge, build, rounds):
        import frame_judge
        cid, key, label = build['localClusterId'], build['buildKey'], f'Build {build["buildKey"][:8]}'
        shot = build['shots'][0]
        allowed = {(cid, shot['shot']): shot}
        receipt = None
        for attempt in ('r0', 'r0b'):
            name = self.next_plan_name(key, attempt)
            self.feed_plan(name, [shot['tsv']])
            receipts = self.wait_plan(name, allowed, timeout=240)
            receipt = receipts.get((cid, shot['shot']))
            if receipt is not None and receipt.get('skipped') == 'world_never_loaded' and attempt == 'r0':
                self.journal('retry', build=key[:8], reason='world_never_loaded on the incumbent; feeding it once more')
                continue
            break
        incumbent = self.judge_shot(judge, {'name': shot['shot'], 'shotKey': shot['shotKey'], 'receipt': receipt})
        history = [incumbent]
        needs, forced_moves = self.gate(incumbent)
        rounds_run, c75_used = 0, False
        if needs and not forced_moves:
            self.journal('decision', build=key[:8], round=0, incumbent=incumbent['name'], winner=incumbent['name'],
                         reason=f'gated: needs-{needs}; no fan spent', candidates=[], needs=needs)
            rounds = 0
        for round_no in range(1, rounds + 1):
            moves = forced_moves if forced_moves else self.fan_moves(incumbent, c75_used)
            pose, fan = candidate_poses(incumbent['receipt'], incumbent['metrics'], moves)
            if not fan:
                self.journal('decision', build=key[:8], round=round_no, incumbent=incumbent['name'], winner=incumbent['name'],
                             reason='no candidate pose could be derived', candidates=[], needs=needs)
                break
            entries, rows = [], []
            for move, p in fan:
                name = f"{incumbent['name']}~{move}"
                rows.append(tsv_row(cid, name, p['cam'], p['yaw'], p['pitch'], p['aim'], label))
                entries.append({'name': name, 'shotKey': shot_key(self.plan['sourceKey'], key, name), 'move': move,
                                'requested': p, 'vetoes': []})
            allowed = {(cid, e['name']): {'shotKey': e['shotKey'], 'shot': e['name']} for e in entries}
            plan_name = self.next_plan_name(key, f'r{round_no}')
            self.journal('fan', build=key[:8], round=round_no, around=incumbent['name'], moves=moves,
                         incumbent_pose={k: pose[k] for k in ('distance', 'elevation', 'azimuth')},
                         candidates=[{'name': e['name'], **e['requested']} for e in entries])
            self.feed_plan(plan_name, rows)
            receipts = self.wait_plan(plan_name, allowed, timeout=90 * len(rows) + 60)
            placed_seen = []
            for e in entries:
                e['receipt'] = receipts.get((cid, e['name']))
                r = e['receipt'] or {}
                if r.get('placed'):
                    here = (r['placed']['x'], r['placed']['y'], r['placed']['z'])
                    twin = next((n for n, q in placed_seen if dist(here, q) < DUPLICATE_M), None)
                    if twin:
                        e['vetoes'] = [f'duplicate:{twin}']
                    placed_seen.append((e['name'], here))
                self.judge_shot(judge, e)
            verdict = frame_judge.compare(incumbent, entries)
            rounds_run = round_no
            self.journal('decision', build=key[:8], round=round_no, incumbent=incumbent['name'],
                         incumbent_score=incumbent['score'], candidates=verdict['rows'],
                         winner=verdict['winner'], reason=verdict['reason'], needs=needs)
            if verdict['winner'] == incumbent['name']:
                break
            incumbent = next(e for e in entries if e['name'] == verdict['winner'])
            if incumbent['move'] == 'c75':
                c75_used = True
            history.append(incumbent)
            if forced_moves:
                break       # a gated build gets one re-aim, not a climb
        self.results[key] = {
            'localClusterId': cid, 'shot': shot['shot'], 'incumbent': history[0]['name'], 'winner': incumbent['name'],
            'needs': needs, 'rounds': rounds_run, 'path': [h['name'] for h in history],
            'winnerFile': incumbent.get('file'), 'winnerShotKey': incumbent['shotKey'],
            'pose': ({k: incumbent['receipt'].get(k) for k in ('lens', 'placed', 'aim', 'yaw', 'pitch', 'clearance')}
                     if incumbent['receipt'] else None),
            'metrics': {h['name']: {'score': h['score'], 'vetoes': h['vetoes'],
                                    **({'liveTileShare': h['metrics']['master']['liveTileShare'],
                                        'centralLiveShare': h['metrics']['master'].get('centralLiveShare'),
                                        'gradMean': h['metrics']['master']['gradMean'],
                                        'lumaMean': h['metrics']['master']['lumaMean'],
                                        'lumaStd': h['metrics']['master']['lumaStd'],
                                        'skyFraction': h['metrics']['geometry']['skyFraction']} if h['metrics'] else {})}
                        for h in history},
        }
        write(self.root / 'refine.json', {'schema': 'steward-refine/v2', 'sourceKey': self.plan['sourceKey'],
                                          'era': self.plan['era'], 'builds': self.results})

    def finish(self):
        (self.feed / 'STOP').write_text('', encoding='utf-8')
        self.journal('stop')
        t0 = time.monotonic()
        while self.game_alive() and time.monotonic() - t0 < 90:
            time.sleep(2)
        self.stop_game()
        code = self.process.poll() if self.process else None
        if self.log:
            self.log.close()
        self.collect_logs(self.dest, self.saves)
        if self.journal_path.exists():
            shutil.copy2(self.journal_path, self.dest / 'refine-journal.jsonl')
        self.journal('exit', code=code, wall_s=round(time.monotonic() - self.t_start, 1))
        self.process = None
        write(self.dest / 'result.json', {'success': True, 'reason': 'refine-complete', 'mode': 'refine',
                                          'builds': len(self.results), 'prefs': self.prefs_receipt(self.saves, self.dest, self.prefs)})
        self.write_summary()

    def write_summary(self):
        if any('request' in r and 'incumbent' not in r for r in self.results.values()):
            lines = ['| request | build | shot | vetoes | score | file |', '|---|---|---|---|---|---|']
            for rid, r in self.results.items():
                score = '-' if r['score'] is None else f"{r['score']:.6f}"
                lines.append(f"| {rid} | {r['buildKey'][:8]} | {r['shot']} | {','.join(r['vetoes']) or '-'} | {score} | {r.get('file') or '-'} |")
            (self.root / 'refine-summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
            return
        lines = ['| build | shot | needs | inc score | inc live | inc luma | winner | win score | Δ | rounds | vetoes |',
                 '|---|---|---|---|---|---|---|---|---|---|---|']
        fmt = lambda v, p=4: '-' if v is None else f'{v:.{p}f}'
        for key, r in self.results.items():
            inc = r['metrics'].get(r['incumbent'], {}); best = r['metrics'].get(r['winner'], {})
            delta = (best['score'] - inc['score']) if best.get('score') is not None and inc.get('score') is not None else None
            lines.append(f"| {key[:8]} | {r['shot']} | {r['needs'] or '-'} | {fmt(inc.get('score'), 6)} | {fmt(inc.get('liveTileShare'), 2)} | "
                         f"{fmt(inc.get('lumaMean'), 2)} | {r['winner'] if r['winner'] != r['incumbent'] else '(incumbent)'} | "
                         f"{fmt(best.get('score'), 6)} | {fmt(delta, 6)} | {r['rounds']} | {','.join(inc.get('vetoes', [])) or '-'} |")
        (self.root / 'refine-summary.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    def run_refine(self, builds_n, rounds):
        import fcntl
        with (self.root / 'worker.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock_acquired = True
            self.status('starting')
            import frame_judge
            judge = frame_judge.Judge(threads=self.threads)     # the model load happens under the world load
            self.journal('judge_ready', model=judge.model_name, load_s=judge.load_s, device=judge.device, threads=judge.threads,
                         thresholds=frame_judge.THRESHOLDS)
            self.launch()
            try:
                self.wait_world()
                requests_mode = (self.plan.get('refine') or {}).get('mode') == 'requests'
                for build in self.plan['builds'][:builds_n]:
                    if self.stopped():
                        self.journal('operator_stop')
                        break
                    if requests_mode or rounds == 0:
                        self.request_build(judge, build)
                    else:
                        self.refine_build(judge, build, rounds)
            finally:
                self.finish()
            self.status('refine-complete', builds=len(self.results))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--prepare', action='store_true', help='write campaign.json/all-shots.tsv for the sample (before install)')
    parser.add_argument('--from-root', type=Path, help='installed campaign root to sample builds and poses from')
    parser.add_argument('--framing', type=Path, help='master_detail JSON whose lowest liveTileShare picks the sample; omit for every build')
    parser.add_argument('--requests', type=Path, help='viewer shot-request ledger (steward-shot-request/v1 JSONL): shoot the requested poses, no fan')
    parser.add_argument('--builds', type=int, default=8)
    parser.add_argument('--rounds', type=int, default=2)
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--idle-seconds', type=int, default=600)
    args = parser.parse_args()
    if args.prepare:
        if not args.from_root:
            parser.error('--prepare needs --from-root')
        if args.requests:
            prepare_requests(args.root, args.from_root, args.requests)
        elif args.framing:
            prepare(args.root, args.from_root, args.framing, args.builds)
        else:
            prepare_all(args.root, args.from_root)
        sys.exit(0)
    worker = RefineWorker(args.root, threads=args.threads, idle_seconds=args.idle_seconds)
    try:
        worker.run_refine(args.builds, args.rounds)
    except Exception as error:
        if worker.lock_acquired:
            try:
                (worker.feed / 'STOP').write_text('', encoding='utf-8')
            except OSError:
                pass
            worker.stop_game()
            worker.status('failed', reason=str(error)[:240])
        raise
