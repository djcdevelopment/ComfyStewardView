#!/usr/bin/env python3
"""Prepare four exterior shots for each queued pilot using exact three-dimensional membership."""
import argparse
from pathlib import Path
import sys
import duckdb
from archive import REPO,artifact,checked_file,load,now,save,sql_path,verify_package
sys.path.insert(0,str(REPO/'tools/selfie-stick'))
from plan_shots import camera_for,elevation_for,orbit_azimuths,validate_tsv


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output-root',type=Path,required=True)
    args=parser.parse_args();root=args.output_root.resolve()
    community=load(root/'analysis/community-private.json');builds={b['buildKey']:b for b in community['builds']}
    jobs=load(root/'analysis/jobs.json')['jobs'];analyses={a['slug']:a for a in load(root/'analysis/catalog.json')['eras']}
    for era in load(root/'catalog.json')['eras']:
        selected=[j for j in jobs if j.get('pilotCandidate') and j['era']==era['era']]
        package=verify_package(root,era);membership=checked_file(root,analyses[era['slug']]['membership'])
        dest=root/'pilots'/era['slug'];dest.mkdir(parents=True,exist_ok=True)
        shots=[];mapping=[]
        with duckdb.connect(':memory:') as con:
            for cid,job in enumerate(selected,1):
                build=builds[job['buildKey']];bounds=build['bounds']
                points=con.execute(f'SELECT z.x,z.y,z.z FROM read_parquet({sql_path(package["zdo"])}) z JOIN read_parquet({sql_path(membership)}) m USING(snapshot_id,zdo_index) WHERE m.build_key=? ORDER BY z.zdo_index',[build['buildKey']]).fetchall()
                if len(points)!=build['pieces']:raise ValueError('Pilot membership count drift')
                cluster={'center_x':(bounds['minX']+bounds['maxX'])/2,'center_z':(bounds['minZ']+bounds['maxZ'])/2,
                         'min_y':bounds['minY'],'max_y':bounds['maxY'],'size_x':bounds['maxX']-bounds['minX'],
                         'size_y':bounds['maxY']-bounds['minY'],'size_z':bounds['maxZ']-bounds['minZ']}
                mapping.append({'localClusterId':cid,'buildKey':build['buildKey'],'pieces':len(points),'membershipSha256':build['membershipSha256']})
                bearings,_=orbit_azimuths(cluster['size_x'],cluster['size_z'])
                for i,azimuth in enumerate(bearings):
                    shot=camera_for(cluster,azimuth,elevation_for(cluster,40),1.2,200,3,points=points)
                    shots.append({'cluster_id':cid,'buildKey':build['buildKey'],'shot':f'orbit{i+1}','label':build['label'],
                                  'environment':'Clear','time_of_day':.64,**shot})
        tsv=dest/'shotplan.tsv'
        with tsv.open('w',encoding='utf-8',newline='\n') as output:
            output.write('# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\taim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\n')
            for shot in shots:
                c=shot['camera'];a=shot['aim']
                row=[shot['cluster_id'],shot['shot'],c['x'],c['y'],c['z'],shot['yaw_deg'],shot['pitch_deg'],'Clear',.64,a['x'],a['y'],a['z'],shot['label'],'',0,'']
                output.write('\t'.join(map(str,row))+'\n')
        good,bad=validate_tsv(str(tsv))
        if bad or good!=len(shots) or len(shots)!=4*len(selected):raise ValueError('Pilot TSV contract failed')
        save(dest/'plan.json',{'schema':'steward-era-pilot/v1','createdAt':now(),'era':era['slug'],'sourceKey':era['sourceKey'],
             'snapshotId':era['snapshotId'],'world':era['worldId'],'dispatch':'manual','status':'awaiting-runtime',
             'resolution':[3840,2160],'optionalInterior':'Choose after runtime and visibility review; no invented interior camera',
             'builds':mapping,'plan':shots,'tsv':artifact(root,tsv),
             'preflight':['era-matched runtime receipt','isolated working save copy','prefab availability thresholds','one active Valheim session','capture plugin compatibility']})
        print(f"{era['slug']}: {len(selected)} pilots, {len(shots)} validated exterior shots",flush=True)

if __name__=='__main__':main()
