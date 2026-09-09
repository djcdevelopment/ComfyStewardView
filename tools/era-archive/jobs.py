#!/usr/bin/env python3
"""Run resumable CPU raster jobs; prepare exclusive, manually dispatched game sessions."""
import argparse
import hashlib
import math
from pathlib import Path
import shutil
import subprocess
import uuid
from archive import REPO,artifact,checked_file,digest,load,now,save,verify_package,verify_sources,writer_lock


def rasters(root,java,jar):
    catalog=load(root/'catalog.json');stamp=digest(jar)
    results=[]
    with writer_lock(root/'raster-jobs'):
        for era in catalog['eras']:
            package=verify_package(root,era)
            dest=root/'rasters'/era['slug']/stamp['sha256'][:16]
            receipt=dest/'receipt.json'
            if receipt.exists():
                job=load(receipt)
                for file in job['files']:checked_file(root,file)
            else:
                dest.mkdir(parents=True,exist_ok=True)
                command=[str(java),'-Xmx6g','-Djava.awt.headless=true','-jar',str(jar),'render','--cache',str(package['cache']),
                         '--snapshot',str(era['snapshotId']),'--artifacts',str(dest),'--lenses','build-density','--resolutions','320,160,80,64,16']
                print(era['slug']+': rendering CPU zoom ladder',flush=True)
                with (dest/'render.log').open('w',encoding='utf-8') as log:subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,check=True)
                manifest=load(dest/str(era['snapshotId'])/'manifest.json')
                sizes={x['cellSize'] for x in manifest['layers'] if x['lensId']=='build-density'}
                if sizes!={320,160,80,64,16}:raise ValueError('Incomplete raster ladder')
                job={'schema':'steward-cpu-raster/v1','status':'verified','completedAt':now(),'slug':era['slug'],
                     'sourceKey':era['sourceKey'],'snapshotId':era['snapshotId'],'renderer':stamp,
                     'files':[artifact(root,p) for p in sorted(dest.rglob('*')) if p.is_file() and p.name!='receipt.json']}
                save(receipt,job)
            results.append(job)
        save(root/'raster-jobs/catalog.json',{'schema':'steward-raster-jobs/v1','jobs':results})


def validate_runtime(root,era,runtime_path):
    slug=era['slug'];runtime=load(runtime_path)
    if runtime.get('schema')!='steward-era-runtime/v1' or runtime.get('sourceKey')!=era['sourceKey']:
        raise ValueError('Runtime is not pinned to this source pair')
    if runtime.get('eraMatched') is not True or not all(runtime.get(k) for k in ('reviewedBy','reviewedAt','versionEvidence','launchInstructions')):
        raise ValueError('Historical runtime needs review evidence and explicit launch instructions')
    for file in runtime.get('files',[]):checked_file(Path(runtime_path).parent,file)
    if not runtime.get('files'):raise ValueError('Runtime receipt has no pinned files')
    availability=runtime.get('availability',{})
    missing=availability.get('missingConstructionFraction')
    if not isinstance(missing,(int,float)) or not math.isfinite(missing) or not 0<=missing<=1:
        raise ValueError('Measure runtime prefab availability first')
    if missing>=.05:raise ValueError('Era crosses the 5% missing-construction threshold; investigate before publishing')
    pilot_path=root/'pilots'/slug/'plan.json'
    if pilot_path.exists():
        measured=availability.get('missingFractionByBuild',{})
        for build in load(pilot_path)['builds']:
            fraction=measured.get(build['buildKey'])
            if not isinstance(fraction,(int,float)) or not math.isfinite(fraction) or not 0<=fraction<=1:
                raise ValueError('Measure availability for every selected pilot build')
            if fraction>=.10:raise ValueError('Selected build crosses the 10% missing-construction threshold')
    return runtime


def prepare_session(root,slug,runtime_path):
    """A reviewed runtime receipt unlocks a *copy*. This command never launches Valheim."""
    era=next(e for e in load(root/'catalog.json')['eras'] if e['slug']==slug)
    verify_sources(era);runtime=validate_runtime(root,era,runtime_path)
    with writer_lock(root/'game-session'):
        active=root/'game-session/active.json'
        if active.exists() and load(active).get('status')!='closed':raise ValueError('Close the current exclusive game session first')
        dest=root/'game-session'/str(uuid.uuid4());dest.mkdir(parents=True)
        for kind in ('db','fwl'):
            source=Path(era[kind]['path']);target=dest/source.name;shutil.copyfile(source,target)
            if digest(target)!={k:era[kind][k] for k in ('bytes','sha256')}:raise ValueError('Copy verification failed')
        session={'schema':'steward-era-session/v1','status':'prepared','dispatch':'manual','era':slug,'sourceKey':era['sourceKey'],
                 'workingDirectory':str(dest),'runtimeReceipt':digest(runtime_path),'instructions':runtime['launchInstructions'],
                 'expectedOutputs':['mapTexCache','heightTexCache','forestMaskTexCache','runtime prefab availability manifest'],
                 'createdAt':now()}
        save(active,session);save(dest/'session.json',session)
        print(str(dest),flush=True)


def close_session(root,completion_path):
    with writer_lock(root/'game-session'):
        active_path=root/'game-session/active.json';active=load(active_path);completion=load(completion_path)
        if active.get('status')!='prepared':raise ValueError('No prepared session to close')
        if completion.get('schema')!='steward-era-session-completion/v1' or completion.get('sourceKey')!=active['sourceKey'] or completion.get('gameStopped') is not True:
            raise ValueError('Completion must identify this source and confirm the game is stopped')
        directory=Path(active['workingDirectory'])
        for kind in ('mapTexCache','heightTexCache','forestMaskTexCache'):
            checked_file(directory,completion['outputs'][kind])
        era=next(e for e in load(root/'catalog.json')['eras'] if e['sourceKey']==active['sourceKey']);verify_sources(era)
        active.update(status='closed',closedAt=now(),completion=digest(completion_path),outputs=completion['outputs'])
        save(directory/'completion.json',completion);save(active_path,active)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['rasters','prepare-session','close-session'])
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--java',default='java')
    parser.add_argument('--jar',type=Path,default=REPO/'lab/target/steward-spatial-lab-0.1.0-SNAPSHOT.jar')
    parser.add_argument('--era');parser.add_argument('--runtime',type=Path)
    parser.add_argument('--completion',type=Path)
    args=parser.parse_args();root=args.output_root.resolve()
    if args.command=='rasters':rasters(root,args.java,args.jar.resolve())
    elif args.command=='prepare-session':
        if not args.era or not args.runtime:parser.error('prepare-session requires --era and --runtime')
        prepare_session(root,args.era,args.runtime)
    else:
        if not args.completion:parser.error('close-session requires --completion')
        close_session(root,args.completion)

if __name__=='__main__':main()
