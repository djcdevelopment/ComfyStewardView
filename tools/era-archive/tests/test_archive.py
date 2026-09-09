import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
import duckdb

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import archive
import community
import gallery
import jobs
from records import ITEMS, count, records, stable_hash


class ArchiveTest(unittest.TestCase):
    def test_runtime_thresholds_require_measurements_instead_of_unknown_names(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);binary=root/'runtime.dll';binary.write_bytes(b'pinned')
            path=root/'runtime.json';era={'slug':'era7','sourceKey':'a'*64}
            runtime={'schema':'steward-era-runtime/v1','sourceKey':era['sourceKey'],'eraMatched':True,
                     'reviewedBy':'steward','reviewedAt':'now','versionEvidence':'historical manifest','launchInstructions':'isolated copy',
                     'files':[archive.artifact(root,binary)],'availability':{'missingConstructionFraction':None}}
            archive.save(path,runtime)
            with self.assertRaises(ValueError):jobs.validate_runtime(root,era,path)
            for fraction in (.05,.9,1.2):
                runtime['availability']['missingConstructionFraction']=fraction
                archive.save(path,runtime)
                with self.assertRaises(ValueError):jobs.validate_runtime(root,era,path)
            runtime['availability']['missingConstructionFraction']=.01
            archive.save(root/'pilots/era7/plan.json',{'builds':[{'buildKey':'b'*64}]})
            runtime['availability']['missingFractionByBuild']={'b'*64:.10};archive.save(path,runtime)
            with self.assertRaises(ValueError):jobs.validate_runtime(root,era,path)
            runtime['availability']['missingFractionByBuild']={'b'*64:.099};archive.save(path,runtime)
            self.assertEqual(runtime,jobs.validate_runtime(root,era,path))

    def test_all_contributors_residuals_vertical_separation_and_bad_positions(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);package={}
            with duckdb.connect(':memory:') as con:
                con.execute('CREATE TABLE world_snapshot(snapshot_id BIGINT)');con.execute('INSERT INTO world_snapshot VALUES (1001)')
                con.execute('CREATE TABLE zdo(snapshot_id BIGINT,zdo_index BIGINT,category VARCHAR,prefab_hash INTEGER,prefab_name VARCHAR,x DOUBLE,y DOUBLE,z DOUBLE,creator_id BIGINT,owner_id BIGINT)')
                con.execute("INSERT INTO zdo VALUES (1001,1,'BUILDING',1,'wall',0,0,0,1,0),(1001,2,'BUILDING',1,'wall',1,0,0,2,0),(1001,3,'BUILDING',1,'wall',0,100,0,3,0),(1001,4,'BUILDING',1,'wall','NaN',0,0,4,0)")
                con.execute('CREATE TABLE zdo_field(snapshot_id BIGINT,zdo_index BIGINT,field_name VARCHAR,string_value VARCHAR)')
                con.execute('CREATE TABLE container_item(crafter_id BIGINT,crafter_name VARCHAR,container_zdo_index BIGINT)')
                con.execute("INSERT INTO container_item VALUES (1,'Same Name',1),(2,'Same Name',2)")
                for table in ('world_snapshot','zdo','zdo_field','container_item'):
                    path=root/(table+'.parquet');con.execute(f'COPY {table} TO {archive.sql_path(path)} (FORMAT PARQUET)');package[table]=path
            entry={'era':7,'slug':'era7','sourceKey':'a'*64,'snapshotId':1001,'ingestion':{'artifacts':{}}}
            with patch.object(community,'verify_package',return_value=package):result=community.analyze_era(root,entry)
            self.assertEqual(4,result['constructionPieces']);self.assertEqual(1,result['quarantinedConstructionPieces'])
            self.assertEqual([1,2],sorted(b['pieces'] for b in result['builds']))
            shared=next(b for b in result['builds'] if b['pieces']==2)
            self.assertEqual({'1','2'},{c['characterId'] for c in shared['contributors']})
            projection=community.project(root,[result])
            self.assertEqual(3,len(projection['builders']))
            self.assertEqual(2,sum(b['displayName']=='Same Name' for b in projection['builders']))
            public_shared=next(b for b in projection['builds'] if b['pieces']==2)
            self.assertEqual([.5,.5],[c['share'] for c in public_shared['contributors']])

    def test_source_pairs_reject_name_mismatch_and_deduplicate_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';source.mkdir();out=root/'processed'
            db=source/'ComfyEra7.db';db.write_bytes(struct.pack('<idqii',29,100.,1,2,1))
            name=b'ComfyEra7';body=struct.pack('<i',29)+bytes([len(name)])+name+b'\x04seed'+struct.pack('<iq',123,456)
            db.with_suffix('.fwl').write_bytes(struct.pack('<i',len(body))+body)
            first=archive.inventory(source,out)
            duplicate=source/'copy';duplicate.mkdir()
            for file in source.glob('*.*'):(duplicate/file.name).write_bytes(file.read_bytes())
            second=archive.inventory(source,out)
            self.assertEqual(1,len(second['eras']))
            self.assertEqual(first['eras'][0]['snapshotId'],second['eras'][0]['snapshotId'])
            self.assertIsNone(second['eras'][0]['saveTimestamp'])
            with self.assertRaises(ValueError):archive.inventory(source,source/'output')
            (source/'Wrong.db').write_bytes(db.read_bytes())
            (source/'Wrong.fwl').write_bytes(db.with_suffix('.fwl').read_bytes())
            with self.assertRaises(ValueError):archive.source_entry(source/'Wrong.db')

    def test_artifact_path_and_digest_are_enforced(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);file=root/'data';file.write_text('verified')
            ref=archive.artifact(root,file);self.assertEqual(file,archive.checked_file(root,ref))
            file.write_text('changed')
            with self.assertRaises(ValueError):archive.checked_file(root,ref)
            with self.assertRaises(ValueError):archive.checked_file(root,{**ref,'path':'../escaped'})

    def test_legacy_and_compact_payloads_have_matching_identities(self):
        self.assertEqual(1305470367,stable_hash('TCData'))
        for version in (29,32,33,34,35):
            with self.subTest(version=version),tempfile.TemporaryDirectory() as temp:
                raw=b'\x00\x01\xff'
                strings=b'\x01'+struct.pack('<i',ITEMS)+b'\x03abc'
                blobs=b'\x01'+struct.pack('<ii',123,len(raw))+raw
                if version<31:
                    prefix=bytearray(71);struct.pack_into('<i',prefix,31,42);struct.pack_into('<fff',prefix,43,1,2,3)
                    payload=bytes(prefix)+b'\x00'*5+strings+blobs
                    record=struct.pack('<qii',1,2,len(payload))+payload
                else:record=struct.pack('<Hhhfffi',192,0,0,1,2,3,42)+strings+blobs
                path=Path(temp)/'world.db';path.write_bytes(struct.pack('<idqii',version,10.,1,2,1)+record)
                row=list(records(path))[0]
                self.assertEqual((0,42,1,2,3),row[:5]);self.assertEqual([('string',ITEMS,'abc'),('bytearray',123,raw)],row[5])
                path.write_bytes(path.read_bytes()[:-1])
                with self.assertRaises(ValueError):list(records(path))
        self.assertEqual((200,1),count(bytes([200]),0,32))
        self.assertEqual((200,2),count(bytes([128,200]),0,33))
        self.assertEqual((200,2),count(chr(200).encode(),0,29))

    def test_identity_requires_review_and_names_never_merge(self):
        namespace=uuid.uuid4()
        self.assertNotEqual(community.builder_key(namespace,'9007199254740993',{}),community.builder_key(namespace,'9007199254740992',{}))
        self.assertEqual('Name',community.clean_name('<color=red>Name</color>'))
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'links.json'
            link={'builderKey':'a'*32,'characterIds':['1','2']}
            archive.save(path,{'schema':'steward-builder-links/v1','links':[link]})
            with self.assertRaises(ValueError):community.read_links(path)
            link.update(evidence='reviewed claim',reviewedBy='steward',reviewedAt='2026-09-09')
            archive.save(path,{'schema':'steward-builder-links/v1','links':[link]})
            links=community.read_links(path)
            self.assertEqual(community.builder_key(namespace,'1',links),community.builder_key(namespace,'2',links))

    def test_public_projection_excludes_private_attribution_and_coordinates(self):
        with tempfile.TemporaryDirectory() as temp:
            key='a'*32;build='b'*64
            doc={'generatedAt':'now','eras':[],'legacyImports':[],
                'builders':[{'builderKey':key,'displayName':'A','aliases':['A'],'nameStatus':'recorded','builds':[build],
                             'characterIds':['9007199254740993'],'observations':[{'private':'private-evidence'}]}],
                'builds':[{'buildKey':build,'era':7,'slug':'era7','label':'House','pieces':3,'photos':[],
                           'contributors':[{'builderKey':key,'pieces':3,'share':1,'evidence':'saved-piece-creator'}],
                           'bounds':{'minX':123.45},'sourceKey':'secret-source','snapshotId':1001}]}
            gallery.project(doc,Path(temp),'https://world.example/world/')
            raw=''.join(p.read_text() for p in Path(temp).rglob('*.json'))
            for private in ('9007199254740993','private-evidence','123.45','secret-source','characterIds','observations'):
                self.assertNotIn(private,raw)
            thread=archive.load(Path(temp)/'threads'/(key+'.json'))
            self.assertIn('era=era7&build='+build,thread['eras'][0]['albums'][0]['worldUrl'])

if __name__=='__main__':unittest.main()
