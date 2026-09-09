#!/usr/bin/env python3
"""Prepare a small, exact-membership capture queue; run before the operator games."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import sys

import duckdb
from archive import REPO, checked_file, digest, load, now, save, sql_path
sys.path.insert(0, str(REPO / 'tools/selfie-stick'))
from plan_shots import camera_for, elevation_for, orbit_azimuths, validate_tsv

HEADER = '# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\taim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\n'


def select_jobs(jobs, era, completed, limit):
    selected, seen = [], set()
    for job in jobs:
        key = job.get('buildKey')
        if (job.get('kind') != 'photography' or job.get('era') != era['era']
                or job.get('sourceKey') != era['sourceKey']
                or job.get('snapshotId') != era['snapshotId']
                or job.get('priorityInvestigation') or key in seen or key in completed):
            continue
        selected.append(job); seen.add(key)
        if len(selected) == limit:
            break
    if len(selected) != limit:
        raise ValueError(f'Only {len(selected)} eligible builds; requested {limit}')
    return selected


def completed_builds(pilot, receipts, source_key):
    if pilot['sourceKey'] != source_key:
        raise ValueError('Completed pilot belongs to another source')
    recorded = {}
    for row in receipts:
        if row.get('skipped') or not row.get('file'):
            continue
        recorded.setdefault(row['cluster_id'], set()).add(row['shot'])
    return {b['buildKey'] for b in pilot['builds']
            if {'orbit1', 'orbit2', 'orbit3', 'orbit4'} <= recorded.get(b['localClusterId'], set())}


def prepare(root, era_slug, destination, limit, pilot_path, receipt_path):
    if destination.exists():
        raise ValueError('Use a new immutable campaign directory')
    era = next(e for e in load(root / 'catalog.json')['eras'] if e['slug'] == era_slug)
    receipts = [json.loads(x) for x in receipt_path.read_text(encoding='utf-8-sig').splitlines() if x.strip()]
    completed = completed_builds(load(pilot_path), receipts, era['sourceKey'])
    selected = select_jobs(load(root / 'analysis/jobs.json')['jobs'], era, completed, limit)
    analysis = next(e for e in load(root / 'analysis/catalog.json')['eras'] if e['slug'] == era_slug)
    if analysis['sourceKey'] != era['sourceKey']:
        raise ValueError('Membership source mismatch')
    membership = checked_file(root, analysis['membership'])
    zdo = checked_file(root, era['ingestion']['artifacts']['zdo'])
    by_key = {j['buildKey']: (i + 1, j) for i, j in enumerate(selected)}
    builds = {}
    with duckdb.connect(':memory:') as con:
        con.execute("SET threads=2; SET memory_limit='768MB'")
        con.execute('CREATE TABLE wanted(build_key VARCHAR PRIMARY KEY)')
        con.executemany('INSERT INTO wanted VALUES (?)', [(k,) for k in by_key])
        query = f'''SELECT m.build_key,z.zdo_index,z.x,z.y,z.z
          FROM read_parquet({sql_path(membership)}) m JOIN wanted USING(build_key)
          JOIN read_parquet({sql_path(zdo)}) z USING(snapshot_id,zdo_index)
          WHERE m.snapshot_id=? ORDER BY m.build_key,z.zdo_index'''
        cursor = con.execute(query, [era['snapshotId']])
        def rows():
            while True:
                chunk = cursor.fetchmany(8192)
                if not chunk: break
                yield from chunk
        for key, group in itertools.groupby(rows(), key=lambda r: r[0]):
            values = list(group); points = [r[2:] for r in values]
            cid, job = by_key[key]; b = job['bounds']
            cluster = {'center_x':(b['minX']+b['maxX'])/2, 'center_z':(b['minZ']+b['maxZ'])/2,
                       'min_y':b['minY'], 'max_y':b['maxY'], 'size_x':b['maxX']-b['minX'],
                       'size_y':b['maxY']-b['minY'], 'size_z':b['maxZ']-b['minZ']}
            shots = []
            for number, azimuth in enumerate(orbit_azimuths(cluster['size_x'], cluster['size_z'])[0], 1):
                camera = camera_for(cluster, azimuth, elevation_for(cluster, 40), 1.2, 200, 3, points=points)
                c, a = camera['camera'], camera['aim']; name = f'orbit{number}'
                row = [cid,name,c['x'],c['y'],c['z'],camera['yaw_deg'],camera['pitch_deg'],
                       'Clear',.64,a['x'],a['y'],a['z'],f'Build {key[:8]}','',0,'']
                shot_key = hashlib.sha256(f"{era['sourceKey']}:{key}:{name}".encode()).hexdigest()
                shots.append({'shotKey':shot_key, 'shot':name, 'tsv':'\t'.join(map(str,row)),
                              'framesWholeBuild':camera['frames_whole_build']})
            builds[key] = {'buildKey':key, 'localClusterId':cid, 'membershipSha256':job['membershipSha256'],
                           'pieces':len(points), 'shots':shots}
    if len(builds) != limit:
        raise ValueError('Selected builds missing exact geometry')
    destination.mkdir(parents=True)
    ordered = [builds[j['buildKey']] for j in selected]
    tsv = destination / 'all-shots.tsv'
    tsv.write_text(HEADER + ''.join(s['tsv']+'\n' for b in ordered for s in b['shots']), encoding='utf-8')
    if validate_tsv(str(tsv)) != (limit*4, 0):
        raise ValueError('Shot TSV contract failed')
    result = {'schema':'steward-local-campaign/v1', 'createdAt':now(), 'era':era_slug,
              'sourceKey':era['sourceKey'], 'snapshotId':era['snapshotId'], 'world':era['worldId'],
              'sourceFiles':{k:{p:era[k][p] for p in ('bytes','sha256')} for k in ('db','fwl')},
              'runtimeMode':'current-client', 'width':3840, 'height':2160,
              'batchSize':100, 'maxOutputBytes':32*1024**3, 'minFreeBytes':20*1024**3,
              'stallSeconds':900, 'maxAttempts':2, 'excludedCompleted':sorted(completed), 'builds':ordered}
    save(destination/'campaign.json',result)
    save(destination/'plan-receipt.json',{'sourceKey':era['sourceKey'],'campaign':digest(destination/'campaign.json'),
                                       'tsv':digest(tsv),'builds':limit,'shots':limit*4,'exactMembership':True})
    print(json.dumps({'builds':limit,'shots':limit*4,'campaignBytes':(destination/'campaign.json').stat().st_size}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--era',required=True)
    parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--limit',type=int,default=1000)
    parser.add_argument('--completed-pilot',type=Path,required=True)
    parser.add_argument('--completed-receipts',type=Path,required=True)
    args=parser.parse_args()
    if args.limit<1:parser.error('limit must be positive')
    prepare(args.output_root,args.era,args.destination,args.limit,args.completed_pilot,args.completed_receipts)
