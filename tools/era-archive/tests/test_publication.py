import json
from pathlib import Path
import sys
import tempfile
import unittest
import duckdb

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from archive import artifact, load, save, sql_path
from prepare_public import selected_eras, spatial_inputs
from terrain_provenance import annotate
from world_bundle import context_records, validate_cache_mode


class PublicationTests(unittest.TestCase):
    def test_incremental_public_export_selects_requested_eras_in_request_order(self):
        archive={'eras':[{'slug':'era7'},{'slug':'era16'}]}
        self.assertEqual(['era16'],[era['slug'] for era in selected_eras(archive,['era16'])])
        with self.assertRaisesRegex(ValueError,'Unknown requested eras'):
            selected_eras(archive,['era99'])
        with self.assertRaisesRegex(ValueError,'Duplicate requested era'):
            selected_eras(archive,['era16','era16'])

    def test_world_bundle_accepts_schema_five_with_or_without_terrain(self):
        validate_cache_mode({'schemaVersion':5,'terrainAvailable':True,
                             'biomeMaskSha256':'a'*64},True)
        validate_cache_mode({'schemaVersion':5,'terrainAvailable':False,
                             'biomeMaskSha256':''},False)
        with self.assertRaisesRegex(ValueError,'biome-classified'):
            validate_cache_mode({'schemaVersion':5,'terrainAvailable':False,
                                 'biomeMaskSha256':''},True)
        with self.assertRaisesRegex(ValueError,'explicitly unclassified'):
            validate_cache_mode({'schemaVersion':5,'terrainAvailable':True,
                                 'biomeMaskSha256':'a'*64},False)

    def test_schema_three_context_includes_its_heightfield_in_the_bundle(self):
        manifest={'schemaVersion':3,'variants':[{'file':'terrain.png'}],
                  'heightfield':{'file':'terrain-height.r16'}}
        self.assertEqual(['terrain.png','terrain-height.r16'],
                         [record['file'] for record in context_records(manifest)])
        with self.assertRaisesRegex(ValueError,'requires a heightfield'):
            context_records({'schemaVersion':3,'variants':[]})

    def inputs(self, root, include_bad_member=False):
        cache=root/'source.duckdb';geometry=root/'geometry.parquet';members=root/'membership.parquet'
        with duckdb.connect(str(cache)) as con:
            con.execute("CREATE TABLE world_snapshot AS SELECT 1001::BIGINT AS snapshot_id")
            con.execute("CREATE TABLE zdo AS SELECT 1::BIGINT AS zdo_index, 'BUILDING' AS category, 2.0 AS x, 3.0 AS y, 4.0 AS z UNION ALL SELECT 2,'BUILDING',1,'NaN'::DOUBLE,1")
            for name,path in [('zdo',geometry),('world_snapshot',root/'world_snapshot.parquet'),('zdo',root/'zdo.parquet')]:
                con.execute(f'COPY {name} TO {sql_path(path)} (FORMAT PARQUET)')
            con.execute(f"COPY (SELECT zdo_index FROM zdo {'WHERE zdo_index=1' if not include_bad_member else ''}) TO {sql_path(members)} (FORMAT PARQUET)")
        files={k:artifact(root,p) for k,p in [('cache',cache),('geometry',geometry),('world_snapshot',root/'world_snapshot.parquet'),('zdo',root/'zdo.parquet')]}
        return {'sourceKey':'a'*64,'snapshotId':1001,'ingestion':{'artifacts':files}},members

    def test_nonfinite_positions_are_accounted_for_without_changing_originals(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);dest=root/'prepared';dest.mkdir()
            era,members=self.inputs(root)
            original=era['ingestion']['artifacts']['cache']
            cache,geometry=spatial_inputs(root,dest,era,members)
            with duckdb.connect(str(cache),read_only=True) as con:
                self.assertEqual([(1,)],con.execute('SELECT zdo_index FROM zdo').fetchall())
            self.assertEqual([2],load(dest/'input-receipt.json')['excludedNonfinitePositionIndexes'])
            self.assertEqual(original,artifact(root,root/'source.duckdb'))

    def test_quarantine_cannot_silently_remove_a_build_member(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);dest=root/'prepared';dest.mkdir();era,members=self.inputs(root,True)
            with self.assertRaisesRegex(ValueError,'exact build membership'):spatial_inputs(root,dest,era,members)

    def test_terrain_generation_requires_matching_snapshot_and_cache_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);context=root/'manifest.json';receipt=root/'generation.json'
            save(context,{'snapshot':{'sha256':'a'*64},'sources':{'mapCache':{'sha256':'b'*64}}})
            generation={'schema':'steward-terrain-generation/v1','mode':'current-client','gameVersion':'0.221.12',
                        'sourceDbSha256':'a'*64,'sources':{'mapCache':'c'*64}}
            save(receipt,generation)
            with self.assertRaisesRegex(ValueError,'cache mismatch'):annotate(context,receipt)
            generation['sources']['mapCache']='b'*64;save(receipt,generation);annotate(context,receipt)
            self.assertEqual('current-client',load(context)['generation']['mode'])
            generation['sourceDbSha256']='c'*64;save(receipt,generation)
            with self.assertRaisesRegex(ValueError,'snapshot mismatch'):annotate(context,receipt)


if __name__=='__main__':unittest.main()
