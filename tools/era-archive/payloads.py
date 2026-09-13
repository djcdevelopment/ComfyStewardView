#!/usr/bin/env python3
"""Supplement typed analytics with exact inventory strings and opaque binary fields."""
import argparse
from pathlib import Path
import uuid
import duckdb
from archive import artifact,checked_file,digest,load,now,save,sql_path,verified_eras,verify_package,verify_sources,writer_lock
from records import ITEMS,records


def extract(root,entry):
    package=verify_package(root,entry);verify_sources(entry)
    dest=root/'payloads'/entry['slug']/entry['sourceKey'][:16];receipt=dest/'receipt.json'
    if receipt.exists():
        result=load(receipt);checked_file(root,result['artifact']);return result
    dest.mkdir(parents=True,exist_ok=True)
    with duckdb.connect(':memory:') as con:
        con.execute("SET threads=2")
        con.execute('CREATE TABLE payload(snapshot_id BIGINT,zdo_index BIGINT,field_type VARCHAR,field_hash INTEGER,string_value VARCHAR,blob_value BLOB)')
        rows=[]
        def flush():
            if not rows:return
            con.execute('INSERT INTO payload SELECT unnest(?::BIGINT[]),unnest(?::BIGINT[]),unnest(?::VARCHAR[]),unnest(?::INTEGER[]),unnest(?::VARCHAR[]),unnest(?::BLOB[])', [list(c) for c in zip(*rows)])
            rows.clear()
        print(entry['slug']+': preserving exact binary and inventory payloads',flush=True)
        for index,prefab,x,y,z,values in records(entry['db']['path']):
            for kind,key,value in values:
                rows.append((entry['snapshotId'],index,kind,key,value if kind=='string' else None,value if kind=='bytearray' else None))
            if len(rows)>=2000:flush()
        flush()
        expected=con.execute(f"SELECT count(*) FROM read_parquet({sql_path(package['zdo_field'])}) WHERE field_type='bytearray' OR (field_type='string' AND field_hash=?)",[ITEMS]).fetchone()[0]
        actual=con.execute('SELECT count(*) FROM payload').fetchone()[0]
        if actual!=expected:raise ValueError(f'Payload count mismatch {actual}/{expected}')
        mismatch=con.execute(f"SELECT count(*) FROM payload p FULL JOIN (SELECT * FROM read_parquet({sql_path(package['zdo_field'])}) WHERE field_type='bytearray' OR (field_type='string' AND field_hash=?)) f USING(snapshot_id,zdo_index,field_type,field_hash) WHERE p.zdo_index IS NULL OR f.zdo_index IS NULL OR (p.field_type='bytearray' AND octet_length(p.blob_value)<>f.blob_size)",[ITEMS]).fetchone()[0]
        if mismatch:raise ValueError('Payload identities or lengths disagree with primary parser')
        target=dest/'zdo_payload.parquet'
        con.execute(f'COPY payload TO {sql_path(target)} (FORMAT PARQUET,COMPRESSION ZSTD)')
    verify_sources(entry)
    result={'schema':'steward-zdo-payload/v1','status':'verified','sourceKey':entry['sourceKey'],'snapshotId':entry['snapshotId'],
            'rows':actual,'completedAt':now(),'artifact':artifact(root,target),
            'reader':digest(Path(__file__).with_name('records.py'))}
    save(receipt,result);return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-root',type=Path,required=True)
    args=parser.parse_args();root=args.output_root.resolve()
    with writer_lock(root):
        catalog=load(root/'catalog.json')
        results=[extract(root,e) for e in verified_eras(catalog)]
        save(root/'payloads/catalog.json',{'schema':'steward-payload-catalog/v1','eras':results})
        with duckdb.connect(str(root/'world-cache.duckdb')) as con:
            paths=','.join(sql_path(checked_file(root,r['artifact'])) for r in results)
            con.execute(f'CREATE OR REPLACE VIEW zdo_payload AS SELECT * FROM read_parquet([{paths}])')
            con.execute('CREATE OR REPLACE VIEW zdo_field_full AS SELECT f.* EXCLUDE(string_value),coalesce(p.string_value,f.string_value) AS string_value,p.blob_value FROM zdo_field f LEFT JOIN zdo_payload p USING(snapshot_id,zdo_index,field_type,field_hash)')
        catalog['readModel']=artifact(root,root/'world-cache.duckdb');save(root/'catalog.json',catalog)
    print(f"VERIFIED {sum(r['rows'] for r in results):,} exact payloads",flush=True)

if __name__=='__main__':main()
