#!/usr/bin/env python3
"""Export archive spatial packages using explicit current prefab geometry artifacts."""
import argparse
from pathlib import Path
import shutil
import subprocess
import duckdb
from archive import REPO, artifact, checked_file, digest, load, save, sql_path


def spatial_inputs(root, dest, era, membership):
    inputs=era['ingestion']['artifacts']
    geometry=checked_file(root,inputs['geometry'])
    cache=checked_file(root,inputs['cache'])
    with duckdb.connect() as con:
        con.execute("SET threads=2; SET memory_limit='1GB'")
        finite='coalesce(isfinite(x) AND isfinite(y) AND isfinite(z),false)'
        bad=con.execute(f"SELECT zdo_index FROM read_parquet({sql_path(geometry)}) WHERE category='BUILDING' AND NOT ({finite}) ORDER BY zdo_index").fetchall()
        quarantine=[r[0] for r in bad]
        if quarantine:
            # Only known non-finite spatial positions are omitted; valid-position
            # geometry mismatches and missing rotations still reach exporter validation.
            placeholders=','.join(str(int(i)) for i in quarantine)
            overlap=con.execute(f'SELECT count(*) FROM read_parquet({sql_path(membership)}) WHERE zdo_index IN ({placeholders})').fetchone()[0]
            if overlap:raise ValueError('Quarantined position is present in exact build membership')
            filtered=dest/'finite-geometry.parquet'
            con.execute(f"COPY (SELECT * FROM read_parquet({sql_path(geometry)}) WHERE category<>'BUILDING' OR ({finite})) TO {sql_path(filtered)} (FORMAT PARQUET)")
            geometry=filtered
            snapshots=checked_file(root,inputs['world_snapshot']);zdos=checked_file(root,inputs['zdo'])
            cache=dest/'spatial-source.duckdb'
            with duckdb.connect(str(cache)) as source:
                source.execute(f'CREATE VIEW world_snapshot AS SELECT * FROM read_parquet({sql_path(snapshots)})')
                source.execute(f'CREATE VIEW zdo AS SELECT * FROM read_parquet({sql_path(zdos)}) WHERE zdo_index NOT IN ({placeholders})')
    save(dest/'input-receipt.json',{'sourceKey':era['sourceKey'],'snapshotId':era['snapshotId'],
        'originalInputs':inputs,'excludedNonfinitePositionIndexes':quarantine,
        'geometry':digest(geometry),'cache':digest(cache)})
    return cache,geometry


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--base-ready-inputs',type=Path,required=True)
    parser.add_argument('--terrain-inputs',type=Path,required=True,help='JSON mapping era slug to optional context directory')
    parser.add_argument('--java',type=Path,required=True);parser.add_argument('--jar',type=Path,required=True)
    parser.add_argument('--piece-geometry',type=Path,required=True)
    parser.add_argument('--piece-geometry-sha256',required=True)
    args=parser.parse_args();root=args.output_root.resolve();dest=args.destination.resolve()
    dest.mkdir(parents=True,exist_ok=True)
    if digest(args.piece_geometry)['sha256']!=args.piece_geometry_sha256:raise ValueError('Geometry catalog hash mismatch')
    catalog=dest/'piece-geometry.json';shutil.copyfile(args.piece_geometry,catalog)
    if digest(catalog)!=digest(args.piece_geometry):raise ValueError('Geometry artifact copy mismatch')
    archive=load(root/'catalog.json');analyses={e['slug']:e for e in load(root/'analysis/catalog.json')['eras']}
    terrains=load(args.terrain_inputs);ready=load(args.base_ready_inputs)
    for era in archive['eras']:
        slug=era['slug'];target=dest/slug;target.mkdir(exist_ok=True)
        analysis=analyses[slug]
        if analysis['sourceKey']!=era['sourceKey']:raise ValueError('Membership source mismatch')
        membership=checked_file(root,analysis['membership'])
        public=target/'public.duckdb'
        if not (target/'export-receipt.json').exists():
            if public.exists():raise ValueError('Incomplete previous export; use a fresh destination')
            cache,geometry=spatial_inputs(root,target,era,membership)
            context=Path(terrains[slug]) if slug in terrains else None
            command=[str(args.java),'-Xmx2g','-cp',str(args.jar),'dev.steward.lab.PublicCacheExporter',
                     str(cache),str(public),str(era['snapshotId']),str(context/'manifest.json') if context else '-',
                     str(geometry),str(catalog),str(REPO/'lab/src/main/resources/prefab-representations.json'),
                     str(REPO/'lab/src/main/resources/prefab-promotion-receipt.json')]
            with (target/'export.log').open('w',encoding='utf-8') as log:
                subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=True)
            save(target/'export-receipt.json',{'sourceKey':era['sourceKey'],'exporter':digest(args.jar),
                'geometryCatalog':digest(catalog),'public':digest(public),'metadata':load(str(public)+'.json')})
        receipt=load(target/'export-receipt.json')
        if receipt['sourceKey']!=era['sourceKey'] or receipt['public']!=digest(public):raise ValueError('Export resume mismatch')
        rasters=list((root/'rasters'/slug).glob('*/receipt.json'))
        if len(rasters)!=1:raise ValueError('Choose one verified raster revision per era')
        raster=load(rasters[0])
        if raster['sourceKey']!=era['sourceKey'] or raster['status']!='verified':raise ValueError('Raster source mismatch')
        for item in raster['files']:checked_file(root,item)
        spec={'slug':slug,'snapshotId':era['snapshotId'],'cache':str(public),'membership':str(membership),
              'artifacts':str(rasters[0].parent)}
        if slug in terrains:spec['context']=terrains[slug]
        ready['eras'].append(spec)
        save(dest/'ready-inputs.json',ready)
        print(f"{slug}: public spatial cache verified",flush=True)
    save(dest/'receipt.json',{'files':[artifact(dest,p) for p in dest.glob('*/export-receipt.json')]})


if __name__=='__main__':main()
