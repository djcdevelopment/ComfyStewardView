#!/usr/bin/env python3
"""AM4-local capture supervisor. Standard library only; no network operations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import time

HEADER = '# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\taim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\n'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
    os.replace(temporary,path)


def stamp(path):
    path=Path(path); h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(4*1024*1024),b''):h.update(block)
    return {'bytes':path.stat().st_size,'sha256':h.hexdigest()}


def verify(path, expected):
    if stamp(path)!={k:expected[k] for k in ('bytes','sha256')}:
        raise ValueError('File hash mismatch: '+str(path))


def png_metadata(path):
    """Only format boundaries and dimensions; no pixel decoding or ranking."""
    path=Path(path)
    with path.open('rb') as stream:
        header=stream.read(24)
        stream.seek(-12,2);tail=stream.read(12)
    if header[:8]!=b'\x89PNG\r\n\x1a\n' or tail!=b'\0\0\0\0IEND\xaeB`\x82':
        raise ValueError('PNG is incomplete')
    return {'bytes':path.stat().st_size,'dimensions':list(struct.unpack('>II',header[16:24]))}


def unfinished(builds, completed):
    return [{**b,'shots':[s for s in b['shots'] if s['shotKey'] not in completed]}
            for b in builds if any(s['shotKey'] not in completed for s in b['shots'])]


def disk_stop(output_bytes, free_bytes, campaign):
    if output_bytes>=campaign['maxOutputBytes']:return 'output-limit'
    if free_bytes<campaign['minFreeBytes']:return 'disk-reserve'
    return None


def should_retry(attempts, maximum=2):
    return attempts<maximum


def failed_attempts(root, group, attempts):
    """Keep launch IDs monotonic, but do not charge deliberate pauses as failures."""
    failures=0
    for number in range(1,attempts+1):
        path=Path(root)/'runs'/f'{group}-attempt-{number:02d}'/'result.json'
        result=read(path) if path.exists() else None
        if result is None or (not result.get('success') and result.get('reason') not in
                              ('operator-stop','output-limit','disk-reserve')):
            failures+=1
    return failures


def progress_stalled(last_progress, current, timeout=900):
    return current-last_progress>=timeout


class Worker:
    def __init__(self, root):
        self.root=Path(root).resolve()
        self.plan=read(self.root/'campaign.json');self.runtime=read(self.root/'runtime.json')
        verify(self.root/'campaign.json',self.runtime['campaign'])
        if self.plan['schema']!='steward-local-campaign/v1' or self.plan['runtimeMode']!='current-client':
            raise ValueError('Unsupported capture campaign')
        if self.runtime['sourceKey']!=self.plan['sourceKey']:
            raise ValueError('Runtime/source mismatch')
        self.game=Path(self.runtime['gameRoot']).resolve();self.cfg=self.game/'BepInEx/config'
        self.capture_root=self.cfg/'comfy-orbit-captures'
        self.state=read(self.root/'state.json') if (self.root/'state.json').exists() else {
            'sourceKey':self.plan['sourceKey'],'completed':{},'attempts':{},'status':'prepared'}
        if self.state['sourceKey']!=self.plan['sourceKey']:raise ValueError('State source mismatch')
        self.stopping=False;self.process=None;self.lock_acquired=False
        for key,value in self.state['completed'].items():
            path=self.root/value['file']
            if not path.resolve().is_relative_to(self.root):raise ValueError('Unsafe completed path')
            if png_metadata(path)!=value['metadata']:raise ValueError('Completed photograph changed')

    def stopped(self):
        return self.stopping or (self.root/'STOP').exists()

    def output_bytes(self):
        # Include incomplete/orphan captures too, not just the completed journal.
        roots=[self.root/'images',self.capture_root]
        return sum(p.stat().st_size for r in roots if r.exists() for p in r.rglob('*.png'))

    def limit(self):
        return disk_stop(self.output_bytes(),shutil.disk_usage(self.root).free,self.plan)

    def status(self, state, **extra):
        self.state['status']=state;write(self.root/'state.json',self.state)
        summary={'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'state':state,
                 'era':self.plan['era'],'completedShots':len(self.state['completed']),
                 'targetShots':sum(len(b['shots']) for b in self.plan['builds']),
                 # outputBytes is what disk_stop measures, so it deliberately counts the
                 # mod's staging tree and any orphan alongside the journal. That makes it
                 # the wrong number to size a campaign from -- it read 19 MB/shot on era 7
                 # against a true 10.6 -- so report the journal's own total beside it.
                 'outputBytes':self.output_bytes(),
                 'journalBytes':sum(v['metadata']['bytes'] for v in self.state['completed'].values()),
                 'freeBytes':shutil.disk_usage(self.root).free,
                 'gamePid':self.process.pid if self.process and self.process.poll() is None else None,
                 'downloadsEnabled':False,**extra}
        write(self.root/'status.json',summary)

    def check_runtime(self):
        for spec in self.runtime['sources'].values():verify(Path(spec['path']),spec)
        plugin_root=self.game/'BepInEx/plugins'
        actual={p.relative_to(plugin_root).as_posix() for p in plugin_root.rglob('*.dll')}
        if actual!=set(self.runtime['plugins']):raise ValueError('Unexpected plugin set')
        for name,spec in self.runtime['plugins'].items():verify(plugin_root/name,spec)
        for spec in self.runtime.get('runtimeFiles',[]):verify(Path(spec['path']),spec)
        if subprocess.run(['pgrep','-x','valheim.x86_64'],capture_output=True).returncode!=1:
            raise ValueError('Another Valheim process is running')
        if subprocess.run(['pgrep','-x','steam'],capture_output=True).returncode!=0:
            raise ValueError('Steam must be running before capture starts')

    def stop_game(self):
        if not self.process or self.process.poll() is not None:return
        # Popen handle belongs only to this attempt, never a name-wide kill.
        self.process.terminate()
        try:self.process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            self.process.kill();self.process.wait(timeout=20)

    def read_receipts(self, allowed):
        path=self.cfg/'shotplan-receipts.jsonl'
        if not path.exists():return []
        found=[]
        for line in path.read_text(encoding='utf-8-sig',errors='replace').splitlines():
            try:row=json.loads(line)
            except json.JSONDecodeError:continue # writer may be midway through the final line
            key=(row.get('cluster_id'),row.get('shot'))
            if key not in allowed or row.get('skipped'):continue
            if not re.fullmatch(r'\d{8}-\d{6}',str(row.get('run',''))):continue
            name=row.get('file','')
            if not name or Path(name).name!=name:continue
            path=self.capture_root/row['run']/name
            try:metadata=png_metadata(path)
            except (OSError,ValueError,struct.error):continue
            if metadata['dimensions']!=[self.plan['width'],self.plan['height']]:continue
            found.append((allowed[key],row,path,metadata))
        return found

    def harvest(self, found):
        for shot,row,path,metadata in found:
            if shot['shotKey'] in self.state['completed']:continue
            dest=self.root/'images'/row['run']/path.name;dest.parent.mkdir(parents=True,exist_ok=True)
            if dest.exists():
                if stamp(dest)!=stamp(path):raise ValueError('Capture destination collision')
            else:
                # Same-machine copy first, durable journal next; remove only the verified duplicate.
                shutil.copy2(path,dest)
                if stamp(path)!=stamp(dest):raise ValueError('Local capture copy mismatch')
            self.state['completed'][shot['shotKey']]={'file':dest.relative_to(self.root).as_posix(),
                'metadata':metadata,'sha256':stamp(dest)['sha256'],'receipt':row}
            write(self.root/'state.json',self.state)
            path.unlink()

    def attempt(self, builds, group, attempt_number):
        self.check_runtime()
        dest=self.root/'runs'/f'{group}-attempt-{attempt_number:02d}'
        dest.mkdir(parents=True,exist_ok=False)
        saves=dest/'xdg/unity3d/IronGate/Valheim';worlds=saves/'worlds_local'
        worlds.mkdir(parents=True);(saves/'characters_local').mkdir()
        for kind in ('db','fwl'):
            spec=self.runtime['sources'][kind];target=worlds/(self.plan['world']+'.'+kind)
            shutil.copy2(spec['path'],target);verify(target,spec);target.chmod(0o600)
        character=self.runtime['sources']['character']
        character_copy=saves/'characters_local'/Path(character['path']).name
        shutil.copy2(character['path'],character_copy);character_copy.chmod(0o600)
        for spec in self.runtime.get('terrainCaches',[]):
            verify(Path(spec['path']),spec)
            cache_copy=worlds/Path(spec['path']).name
            shutil.copy2(spec['path'],cache_copy);cache_copy.chmod(0o600)
        reason='operator-stop' if self.stopped() else self.limit()
        if reason:
            write(dest/'result.json',{'success':False,'reason':reason,'launched':False})
            return False,reason
        allowed={(b['localClusterId'],s['shot']):s for b in builds for s in b['shots']}
        for name in ('shotplan.tsv','shotplan-receipts.jsonl','orbit-request.json'):
            p=self.cfg/name
            if p.exists():shutil.copy2(p,dest/('before-'+name))
        (self.cfg/'shotplan.tsv').write_text(HEADER+''.join(s['tsv']+'\n' for b in builds for s in b['shots']),encoding='utf-8')
        (self.cfg/'shotplan-receipts.jsonl').write_text('',encoding='utf-8')
        write(self.cfg/'orbit-request.json',{'world':self.plan['world'],'character':self.runtime['character'], 'quit_when_done':True})
        write(dest/'dispatch.json',{'sourceKey':self.plan['sourceKey'],'builds':builds,'runtimeMode':'current-client'})
        self.state['activeAttempt']=dest.relative_to(self.root).as_posix()
        write(self.root/'state.json',self.state)
        command=['./start_game_bepinex.sh','-console','-screen-fullscreen','1','-screen-width',str(self.plan['width']),
                 '-screen-height',str(self.plan['height']),'-monitor','1']
        env=os.environ.copy();env.update(DISPLAY=':0',SDL_VIDEODRIVER='x11',XDG_CONFIG_HOME=str(dest/'xdg'))
        log=(dest/'stdout.log').open('wb')
        self.process=subprocess.Popen(command,cwd=self.game,env=env,stdin=subprocess.DEVNULL,
                                      stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        write(dest/'launch.json',{'pid':self.process.pid,'command':command,'xdgConfigHome':str(dest/'xdg')})
        last_progress=time.monotonic();last_count=0;reason='process-exit'
        try:
            while self.process.poll() is None:
                self.harvest(self.read_receipts(allowed))
                count=sum(s['shotKey'] in self.state['completed'] for s in allowed.values())
                if count>last_count:last_progress=time.monotonic();last_count=count
                self.status('capturing',batch=group,attempt=attempt_number,batchShots=count,batchTarget=len(allowed))
                if self.stopped():reason='operator-stop';break
                if self.limit():reason=self.limit();break
                if progress_stalled(last_progress,time.monotonic(),self.plan['stallSeconds']):reason='stalled';break
                time.sleep(10)
        finally:
            self.stop_game();log.close()
            self.harvest(self.read_receipts(allowed))
            for src,name in ((self.game/'BepInEx/LogOutput.log','BepInEx.log'),(saves/'Player.log','Player.log'),
                             (self.cfg/'shotplan-receipts.jsonl','receipts.jsonl')):
                if src.exists():shutil.copy2(src,dest/name)
            request=self.cfg/'orbit-request.json'
            if request.exists():request.rename(dest/'completed-orbit-request.json')
            self.process=None
        success=all(s['shotKey'] in self.state['completed'] for s in allowed.values())
        activation='Starting ConnectPortals coroutine with cache' in (dest/'BepInEx.log').read_text(errors='replace')
        success=success and activation
        write(dest/'result.json',{'success':success,'reason':reason,'portalCacheActive':activation,
                                 'completed':sum(s['shotKey'] in self.state['completed'] for s in allowed.values()),'expected':len(allowed)})
        if success:
            # Disposable local save copies only. Raw images, receipts, sources and logs remain.
            scratch=dest/'xdg'
            if scratch.is_symlink() or not scratch.resolve().is_relative_to((self.root/'runs').resolve()):
                raise ValueError('Unsafe scratch cleanup path')
            shutil.rmtree(scratch)
        return success,reason if activation else 'portal-cache-not-active'

    def run(self, smoke=False):
        import fcntl
        with (self.root/'worker.lock').open('a+') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.lock_acquired=True
            def stop(_signum,_frame):self.stopping=True
            signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
            self.status('starting');self.check_runtime()
            # Recover the last completed writes before replacing any control files.
            if self.state.get('activeAttempt'):
                prior=(self.root/self.state['activeAttempt']).resolve()
                if not prior.is_relative_to(self.root/'runs'):raise ValueError('Unsafe recovery path')
                dispatch=read(prior/'dispatch.json')
                if dispatch['sourceKey']!=self.plan['sourceKey']:raise ValueError('Recovery source mismatch')
                allowed={(b['localClusterId'],s['shot']):s for b in dispatch['builds'] for s in b['shots']}
                self.harvest(self.read_receipts(allowed))
            builds=self.plan['builds'][:1] if smoke else self.plan['builds']
            groups=[('smoke',builds)] if smoke else [(f'batch-{i//self.plan["batchSize"]:04d}',builds[i:i+self.plan['batchSize']])
                                                  for i in range(0,len(builds),self.plan['batchSize'])]
            for name,group in groups:
                pending=unfinished(group,self.state['completed'])
                if not pending:continue
                while pending:
                    reason='operator-stop' if self.stopped() else self.limit()
                    if reason:self.status('stopped',reason=reason);return
                    attempts=self.state['attempts'].get(name,0)
                    failures=failed_attempts(self.root,name,attempts)
                    if not should_retry(failures,self.plan['maxAttempts']):
                        self.status('failed',reason='repeated-failure',batch=name);return
                    self.state['attempts'][name]=attempts+1;self.status('preparing',batch=name,attempt=attempts+1)
                    success,reason=self.attempt(pending,name,attempts+1)
                    if reason in ('operator-stop','output-limit','disk-reserve'):
                        self.status('stopped',reason=reason);return
                    pending=unfinished(group,self.state['completed'])
                    if not success and not pending:
                        self.status('failed',reason=reason);return
            state='smoke-passed' if smoke else 'complete';self.status(state)
            if smoke:write(self.root/'smoke-result.json',{'passed':True,'shots':4,'resolution':[self.plan['width'],self.plan['height']],
                                                       'sourceKey':self.plan['sourceKey']})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--smoke',action='store_true');args=parser.parse_args()
    worker=Worker(args.root)
    try:worker.run(args.smoke)
    except Exception as error:
        if worker.lock_acquired:
            worker.stop_game();worker.status('failed',reason=str(error)[:240])
        raise
