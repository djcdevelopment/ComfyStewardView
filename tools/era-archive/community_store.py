#!/usr/bin/env python3
"""Materialize private community tables as Parquet and reconstructible DuckDB views."""
import argparse
import json
from pathlib import Path
import uuid
import duckdb
from archive import artifact,digest,load,now,rebuild_read_model,save,sql_path,writer_lock


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-root',type=Path,required=True)
    args=parser.parse_args();root=args.output_root.resolve()
    with writer_lock(root):
        source=root/'analysis/community-private.json';document=load(source)
        dest=root/'community-tables'/digest(source)['sha256'][:16];dest.mkdir(parents=True,exist_ok=True)
        refs={};counts={}
        with duckdb.connect(':memory:') as con:
            con.execute('SET threads=4')
            def write(table,rows):
                jsonl=dest/(table+'.jsonl');count=0
                with jsonl.open('w',encoding='utf-8') as stream:
                    for row in rows:
                        stream.write(json.dumps(row,ensure_ascii=False,allow_nan=False)+'\n');count+=1
                if not count:return
                parquet=dest/(table+'.parquet')
                con.execute(f"COPY (SELECT * FROM read_json_auto({sql_path(jsonl)},format='newline_delimited',sample_size=-1)) TO {sql_path(parquet)} (FORMAT PARQUET,COMPRESSION ZSTD)")
                refs[table]=artifact(root,parquet);counts[table]=count
            write('builder',({'builder_key':b['builderKey'],'display_name':b['displayName'],'name_status':b['nameStatus'],'aliases':b['aliases']} for b in document['builders']))
            write('builder_character',({'builder_key':b['builderKey'],'character_id':c} for b in document['builders'] for c in b['characterIds']))
            write('name_observation',({'builder_key':b['builderKey'],'character_id':o['characterId'],'name':o['name'],'era':o['era'],
                 'snapshot_id':o['snapshotId'],'source_key':o['sourceKey'],'evidence_type':o['source'],'observations':o['observations'],'example_zdo':o['exampleZdo']} for b in document['builders'] for o in b['observations']))
            write('build',({'build_key':b['buildKey'],'era':b['era'],'snapshot_id':b.get('snapshotId'),'source_key':b.get('sourceKey'),
                 'label':b['label'],'pieces':b['pieces'],'bounds':b.get('bounds'),'membership_sha256':b.get('membershipSha256'),
                 'legacy_cluster_id':b.get('legacyClusterId'),'attribution':b.get('attribution','saved-piece-creator')} for b in document['builds']))
            write('build_contributor',({'build_key':b['buildKey'],'builder_key':c['builderKey'],'pieces':c['pieces'],'share':c.get('share'),'evidence_type':c['evidence']} for b in document['builds'] for c in b['contributors']))
            write('build_photo',({'build_key':b['buildKey'],'era':b['era'],'photo_id':p['id'],'thumb':p['thumb'],'large':p['large'],'gallery_url':p['href']} for b in document['builds'] for p in b['photos']))
        catalog=load(root/'catalog.json')
        receipt={'schema':'steward-community-tables/v1','createdAt':now(),'source':digest(source),'counts':counts,'tables':refs,
                 'sourceKeys':[e['sourceKey'] for e in catalog['eras']]}
        save(root/'analysis/read-model.json',receipt)
        rebuild_read_model(root,catalog)
        print(json.dumps(counts),flush=True)

if __name__=='__main__':main()
