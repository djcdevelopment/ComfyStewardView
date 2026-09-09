#!/usr/bin/env python3
"""Create a verified world catalog, retaining the current ready era during archive preparation.

Ready inputs are explicit public caches produced by PublicCacheExporter, with matched
terrain/raster packages. The server independently validates every ready package at startup.
Private analytics caches are never copied by this command.
"""
import argparse
from pathlib import Path
import shutil
import duckdb
from archive import artifact,checked_file,digest,load,now,save,sql_path
from jobs import validate_runtime


def add_ready(root, spec):
    slug=spec['slug'];snapshot=int(spec['snapshotId'])
    if slug!='era'+str(int(slug.removeprefix('era'))):raise ValueError('Invalid era slug')
    cache=Path(spec['cache']);metadata=load(str(cache)+'.json')
    if metadata.get('schemaVersion')!=4 or metadata.get('snapshotId')!=snapshot or metadata.get('sha256')!=digest(cache)['sha256']:
        raise ValueError('Public cache metadata or byte hash mismatch')
    with duckdb.connect(str(cache),read_only=True) as con:
        columns={r[1] for r in con.execute("PRAGMA table_info('zdo')").fetchall()}
        if columns & {'creator_id','owner_id','text','items','creatorId','ownerId'}:raise ValueError('Private cache refused')
        worlds=con.execute('SELECT snapshot_id,world_id,file_hash FROM world_snapshot').fetchall()
        if len(worlds)!=1 or worlds[0][0]!=snapshot or worlds[0][1].lower()!='comfy'+slug or worlds[0][2]!=metadata['snapshotHash']:
            raise ValueError('World identity mismatch')
    dest=root/slug;dest.mkdir(parents=True)
    output=dest/'public.duckdb';shutil.copyfile(cache,output)
    if digest(cache)!=digest(output):raise ValueError('Cache transfer mismatch')
    context=Path(spec['context']);context_manifest=load(context/'manifest.json')
    if context_manifest['snapshot']['id']!=snapshot or context_manifest['snapshot']['sha256']!=metadata['snapshotHash']:
        raise ValueError('Context identity mismatch')
    context_output=dest/'context';context_output.mkdir()
    shutil.copyfile(context/'manifest.json',context_output/'manifest.json')
    for variant in context_manifest['variants']:
        path=checked_file(context,{'path':variant['file'],'sha256':variant['sha256'],'bytes':variant['bytes']})
        shutil.copyfile(path,context_output/variant['file'])
    raster=Path(spec['artifacts'])/str(snapshot);manifest=load(raster/'manifest.json')
    if manifest['snapshot']['fileHash']!=metadata['snapshotHash']:raise ValueError('Raster identity mismatch')
    raster_output=dest/'artifacts'/str(snapshot);raster_output.mkdir(parents=True)
    shutil.copyfile(raster/'manifest.json',raster_output/'manifest.json')
    for layer in manifest['layers']:
        filename=layer['file']
        if Path(filename).name!=filename:raise ValueError('Unsafe raster filename')
        shutil.copyfile(raster/filename,raster_output/filename)
    if spec.get('membership'):
        membership=Path(spec['membership'])
        with duckdb.connect(str(output)) as con:
            con.execute(f'CREATE TABLE build_membership AS SELECT snapshot_id,build_key,zdo_index FROM read_parquet({sql_path(membership)})')
            bad=con.execute("SELECT count(*) FROM build_membership m LEFT JOIN zdo z USING(snapshot_id,zdo_index) WHERE z.zdo_index IS NULL OR NOT regexp_full_match(m.build_key,'[a-f0-9]{64}')").fetchone()[0]
            duplicates=con.execute('SELECT count(*)-count(DISTINCT zdo_index) FROM build_membership').fetchone()[0]
            if bad or duplicates:raise ValueError('Build membership is not exact for this public snapshot')
            con.execute('CREATE INDEX membership_build ON build_membership(build_key)')
    return {'slug':slug,'label':'Comfy Era '+slug[3:],'status':'ready','snapshotId':snapshot,
            'cache':output.relative_to(root).as_posix(),'contextManifest':(context_output/'manifest.json').relative_to(root).as_posix(),
            'artifacts':(dest/'artifacts').relative_to(root).as_posix(),
            'files':[artifact(root,p) for p in sorted(dest.rglob('*')) if p.is_file()]}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--ready-inputs',type=Path,required=True,help='Explicit JSON ready package list; current era first')
    parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args();root=args.destination.resolve()
    if root.exists():raise ValueError('Use a new immutable bundle directory')
    root.mkdir(parents=True)
    inputs=load(args.ready_inputs)
    sources={e['slug']:e for e in load(args.output_root/'catalog.json')['eras']}
    eras=[]
    for spec in inputs['eras']:
        if spec['slug'] in sources:
            if not spec.get('runtime'):raise ValueError('Archived era publication requires its reviewed historical runtime receipt')
            validate_runtime(args.output_root,sources[spec['slug']],Path(spec['runtime']))
            if load(str(spec['cache'])+'.json')['snapshotHash']!=sources[spec['slug']]['db']['sha256']:
                raise ValueError('Ready cache is not the inventoried source revision')
            analyses={e['slug']:e for e in load(args.output_root/'analysis/catalog.json')['eras']}
            analysis=analyses[spec['slug']]
            if analysis['sourceKey']!=sources[spec['slug']]['sourceKey']:
                raise ValueError('Build analysis source revision mismatch')
            exact=checked_file(args.output_root,analysis['membership'])
            if not spec.get('membership') or digest(Path(spec['membership']))!=digest(exact):
                raise ValueError('Archived era requires its verified exact build membership')
        eras.append(add_ready(root,spec))
    ready={e['slug'] for e in eras}
    for era in load(args.output_root/'catalog.json')['eras']:
        if era['slug'] not in ready:eras.append({'slug':era['slug'],'label':era['worldName'],'snapshotId':era['snapshotId'],'status':'awaiting-runtime'})
    catalog={'schema':'steward-world-catalog/v1','defaultEra':inputs['defaultEra'],'createdAt':now(),'eras':sorted(eras,key=lambda e:int(e['slug'][3:]))}
    save(root/'catalog.json',catalog)
    save(root/'receipt.json',{'schema':'steward-world-bundle/v1','createdAt':now(),'files':[artifact(root,p) for p in sorted(root.rglob('*')) if p.is_file()]})
    print(root/'catalog.json')

if __name__=='__main__':main()
