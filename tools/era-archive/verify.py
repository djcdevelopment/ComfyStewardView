#!/usr/bin/env python3
"""Reconcile the reconstructed archive and community tables; write a reproducible integrity receipt."""
import argparse
import json
from pathlib import Path
import duckdb
from archive import artifact,digest,load,now,save,verified_eras,verify_sources


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-root',type=Path,required=True)
    args=parser.parse_args();root=args.output_root.resolve();catalog=load(root/'catalog.json')
    analysis=load(root/'analysis/community-private.json');reports={e['era']:e for e in analysis['eras']}
    results=[]
    with duckdb.connect(str(root/'world-cache.duckdb'),read_only=True) as con:
        con.execute('SET threads=4');con.execute("SET memory_limit='8GB'")
        for era in verified_eras(catalog):
            verify_sources(era);snapshot=era['snapshotId'];counts={}
            for table in ('zdo','zdo_field','container_item'):
                counts[table]=con.execute(f'SELECT count(*) FROM {table} WHERE snapshot_id=?',[snapshot]).fetchone()[0]
                if counts[table]!=era['ingestion']['counts'][table]:raise ValueError(table+' reconstruction count drift')
            unique=con.execute('SELECT count(DISTINCT zdo_index) FROM zdo WHERE snapshot_id=?',[snapshot]).fetchone()[0]
            if unique!=era['declaredZdos']:raise ValueError('Duplicate or missing object identities')
            members=con.execute('SELECT count(*),count(DISTINCT zdo_index) FROM build_member WHERE snapshot_id=?',[snapshot]).fetchone()
            audit=reports[era['era']]
            if members[0]!=members[1] or members[0]+audit['quarantinedConstructionPieces']!=audit['constructionPieces']:
                raise ValueError('Build membership/quarantine reconciliation failed')
            results.append({'era':era['era'],'sourceKey':era['sourceKey'],'snapshotId':snapshot,'counts':counts,
                            'constructionPieces':audit['constructionPieces'],'buildMembers':members[0],
                            'quarantinedConstructionPieces':audit['quarantinedConstructionPieces'],
                            'originalDb':{k:era['db'][k] for k in ('bytes','sha256')},
                            'originalFwl':{k:era['fwl'][k] for k in ('bytes','sha256')},'status':'verified'})
        totals={table:con.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in
                ('zdo','zdo_field','zdo_payload','container_item','build','build_contributor','build_member','build_photo','builder','name_observation')}
        # build_resident exists only once some era has produced one -- community_store.write()
        # skips a table with no rows, so the view is genuinely absent on an archive analysed
        # before bed residency, and counting it unconditionally would fail an archive that is
        # entirely correct. Look first, then count.
        for table in con.execute("SELECT table_name FROM information_schema.tables WHERE table_name='build_resident'").fetchall():
            totals[table[0]]=con.execute(f'SELECT count(*) FROM {table[0]}').fetchone()[0]
        if con.execute('SELECT count(DISTINCT build_key) FROM build').fetchone()[0]!=totals['build']:raise ValueError('Build key collision')
        orphans=con.execute('SELECT count(*) FROM build_contributor c LEFT JOIN build b USING(build_key) LEFT JOIN builder u USING(builder_key) WHERE b.build_key IS NULL OR u.builder_key IS NULL').fetchone()[0]
        if orphans:raise ValueError('Orphan attribution')
        # The same reconciliation for the sidecar, and deliberately only as far as the build:
        # a resident is not required to have a builder row. A builder exists because a piece
        # creator or a recorded name put them there, and a bed whose ZDO carries no ownerName
        # gives neither -- see readme "Recorded builder". A residency pointing at a build that
        # is not in the table is a different thing entirely: a join that lost its subject.
        if 'build_resident' in totals:
            stray=con.execute('SELECT count(*) FROM build_resident r LEFT JOIN build b USING(build_key) WHERE b.build_key IS NULL').fetchone()[0]
            if stray:raise ValueError('Orphan bed residency')
            totals['build_resident_without_builder']=con.execute('SELECT count(*) FROM build_resident r LEFT JOIN builder u USING(builder_key) WHERE u.builder_key IS NULL').fetchone()[0]
    receipt={'schema':'steward-archive-integrity/v1','verifiedAt':now(),'status':'verified','eras':results,'totals':totals,
             'database':artifact(root,root/'world-cache.duckdb'),'readModelReconstructedFromParquet':True,
             'legacyPhotoImports':[{k:e[k] for k in ('slug','images','albums','unresolvedImages')} for e in analysis['legacyImports']],
             'runtimeStatus':'manual historical-runtime sessions pending; CPU rasters complete'}
    save(root/'validation/integrity.json',receipt);print(json.dumps(totals),flush=True)

if __name__=='__main__':main()
