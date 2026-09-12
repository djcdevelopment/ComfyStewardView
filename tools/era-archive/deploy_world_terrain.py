#!/usr/bin/env python3
"""Deploy one verified terrain context plus the thin app JAR without copying the world catalog."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

from archive import REPO, digest, load, now, save
from deploy_gallery import remote
from deploy_world_code import validate_thin_jar


SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")


def validate_terrain_context(root):
    root = Path(root).resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"Terrain manifest not found: {manifest_path}")
    manifest = load(manifest_path)
    if manifest.get("schemaVersion") != 3 or manifest.get("kind") != "steward-terrain-context":
        raise ValueError("Expected a schema 3 Steward terrain context")
    snapshot = manifest.get("snapshot") or {}
    if not isinstance(snapshot.get("id"), int) or snapshot["id"] <= 0:
        raise ValueError("Terrain context lacks a snapshot ID")
    if not re.fullmatch(r"[a-f0-9]{64}", str(snapshot.get("sha256", ""))):
        raise ValueError("Terrain context lacks a snapshot hash")
    records = list(manifest.get("variants") or [])
    heightfield = manifest.get("heightfield") or {}
    if (heightfield.get("encoding") != "uint16-le" or
            heightfield.get("bytes") != heightfield.get("width", 0) * heightfield.get("height", 0) * 2):
        raise ValueError("Terrain context lacks a complete uint16 heightfield")
    records.append(heightfield)
    files = [manifest_path]
    names = set()
    for record in records:
        name = record.get("file")
        if not isinstance(name, str) or not SAFE_NAME.fullmatch(name) or name in names:
            raise ValueError(f"Unsafe or duplicate terrain file: {name!r}")
        names.add(name)
        path = (root / name).resolve()
        if path.parent != root or not path.is_file():
            raise ValueError(f"Terrain file not found: {name}")
        expected = {key: record.get(key) for key in ("bytes", "sha256")}
        if digest(path) != expected:
            raise ValueError(f"Terrain file integrity mismatch: {name}")
        files.append(path)
    actual = {path.name for path in root.iterdir() if path.is_file()}
    expected = {path.name for path in files}
    if actual != expected:
        raise ValueError(f"Terrain context file set drift: {sorted(actual.symmetric_difference(expected))}")
    return manifest, sorted(files, key=lambda path: path.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--era", required=True)
    parser.add_argument("--jar", type=Path, required=True,
                        help="Maven's target/original-steward-spatial-lab-*.jar")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--ssh-target", default="am4")
    parser.add_argument("--remote-root", default="/home/derek/steward-world")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        raise ValueError("Use a complete source commit")
    if not re.fullmatch(r"era[0-9]+", args.era):
        raise ValueError("Invalid era slug")
    if not re.fullmatch(r"/home/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+", args.remote_root):
        raise ValueError("Invalid deployment root")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", args.ssh_target):
        raise ValueError("Invalid SSH alias")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    dirty = subprocess.check_output(
        ["git", "status", "--porcelain", "--", "lab", "tools/era-archive"],
        cwd=REPO, text=True)
    if head != args.revision or dirty.strip():
        raise ValueError("Commit the reviewed terrain implementation before release")

    manifest, context_files = validate_terrain_context(args.context)
    jar = validate_thin_jar(args.jar)
    with tempfile.TemporaryDirectory(prefix="steward-terrain-") as temporary:
        archive = Path(temporary) / "terrain.tgz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(jar, arcname="steward-code.jar", recursive=False)
            for path in context_files:
                tar.add(path, arcname="context/" + path.name, recursive=False)
        archive_stamp = digest(archive)
        release = (args.revision[:12] + "-terrain-" + args.era + "-" +
                   archive_stamp["sha256"][:12])
        remote_archive = "/tmp/steward-world-" + release + ".tgz"
        remote(args.ssh_target,
               'import subprocess\nsubprocess.run(["docker","inspect","-f","{{.State.Running}}",'
               '"steward-world"],check=True,capture_output=True)\n')
        subprocess.run([
            "scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            str(archive), args.ssh_target + ":" + remote_archive,
        ], check=True)
        settings = {
            "root": args.remote_root,
            "archive": remote_archive,
            "release": release,
            "revision": args.revision,
            "era": args.era,
            "sha256": archive_stamp["sha256"],
            "bytes": archive_stamp["bytes"],
            "jar": digest(jar),
            "snapshotId": manifest["snapshot"]["id"],
            "snapshotSha256": manifest["snapshot"]["sha256"],
            "contextFiles": {path.name: digest(path) for path in context_files},
        }
        result = json.loads(remote(args.ssh_target, "settings=" + repr(settings) + "\n" + REMOTE))
        save(args.receipt, {
            "schema": "steward-world-terrain-deployment/v1",
            "deployedAt": now(),
            "revision": args.revision,
            "era": args.era,
            "snapshotId": manifest["snapshot"]["id"],
            "contextManifest": digest(args.context / "manifest.json"),
            "archive": archive_stamp,
            "remote": result,
        })
        print(json.dumps(result))


REMOTE = r'''
import datetime,hashlib,json,os,shutil,socket,subprocess,tarfile,time,urllib.request
from pathlib import Path

def run(*args):
    return subprocess.check_output(args,text=True,stderr=subprocess.PIPE).strip()
def stamp(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(8*1024*1024),b''):value.update(block)
    return {'bytes':path.stat().st_size,'sha256':value.hexdigest()}
def write_json(path,value):
    candidate=path.with_name(path.name+'.terrain-new')
    candidate.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    os.replace(candidate,path)

root=Path(settings['root']).resolve();incoming=Path(settings['archive'])
assert root==Path('/home')/root.parts[2]/root.parts[3]
assert incoming.stat().st_size==settings['bytes'] and stamp(incoming)['sha256']==settings['sha256']
old=json.loads(run('docker','inspect','steward-world'))[0];assert old['State']['Running'] is True
base=old['Config']['Image'];assert base.startswith('steward-world:');run('docker','image','inspect',base)
mounts={mount['Destination']:mount for mount in old['Mounts']}
source_catalog=Path(mounts['/catalog']['Source']).resolve();requests_dir=Path(mounts['/requests']['Source']).resolve()
releases=(root/'releases').resolve()
assert source_catalog.is_dir() and source_catalog.is_relative_to(releases)
assert mounts['/catalog']['RW'] is False and (source_catalog/'catalog.json').is_file()
assert requests_dir==(root/'shot-requests').resolve() and requests_dir.is_dir()

dest=releases/settings['release'];assert not dest.exists();dest.mkdir(parents=True)
staging=dest/'incoming';staging.mkdir()
with tarfile.open(incoming) as tar:
    members=tar.getmembers()
    for member in members:
        assert member.isfile() and (staging/member.name).resolve().is_relative_to(staging.resolve())
    tar.extractall(staging,filter='data')
incoming.unlink()
assert {path.relative_to(staging).as_posix() for path in staging.rglob('*') if path.is_file()}==(
    {'steward-code.jar'}|{'context/'+name for name in settings['contextFiles']})
for name,record in settings['contextFiles'].items():
    assert stamp(staging/'context'/name)==record
code_jar=dest/'steward-code.jar';os.replace(staging/'steward-code.jar',code_jar)
assert stamp(code_jar)==settings['jar'];code_jar.chmod(0o444)

# A hard-link clone gives the release its own immutable catalog tree without transferring or
# duplicating the hundreds of megabytes of DuckDB/artifact data. Replaced context files get new
# inodes, so the preceding release remains a complete rollback target.
catalog=dest/'catalog';shutil.copytree(source_catalog,catalog,copy_function=os.link)
catalog_document=json.loads((catalog/'catalog.json').read_text(encoding='utf-8'))
selected=next(item for item in catalog_document['eras'] if item['slug']==settings['era'])
assert selected['status']=='ready' and selected['snapshotId']==settings['snapshotId']
context_relative=Path(selected['contextManifest'])
assert context_relative.as_posix()==settings['era']+'/context/manifest.json'
context_dir=(catalog/context_relative.parent).resolve()
assert context_dir.is_relative_to(catalog.resolve())
shutil.rmtree(context_dir);context_dir.mkdir()
for name in settings['contextFiles']:
    os.replace(staging/'context'/name,context_dir/name);(context_dir/name).chmod(0o444)
staging.rmdir()

manifest=json.loads((context_dir/'manifest.json').read_text(encoding='utf-8'))
assert manifest['schemaVersion']==3 and manifest['kind']=='steward-terrain-context'
assert manifest['snapshot']=={'id':settings['snapshotId'],'sha256':settings['snapshotSha256']}
declared={item['file']:(item['bytes'],item['sha256']) for item in manifest['variants']}
height=manifest['heightfield'];declared[height['file']]=(height['bytes'],height['sha256'])
assert set(declared)|{'manifest.json'}==set(settings['contextFiles'])
for name,(size,sha) in declared.items():assert stamp(context_dir/name)=={'bytes':size,'sha256':sha}

prefix=settings['era']+'/context/'
selected['files']=[item for item in selected['files'] if not item['path'].startswith(prefix)]
selected['files']+=sorted(({'path':prefix+path.name,**stamp(path)} for path in context_dir.iterdir()),
                          key=lambda item:item['path'])
selected['files'].sort(key=lambda item:item['path'])
created=datetime.datetime.now(datetime.timezone.utc).isoformat()
catalog_document['createdAt']=created;write_json(catalog/'catalog.json',catalog_document)
receipt_path=catalog/'receipt.json';receipt=json.loads(receipt_path.read_text(encoding='utf-8'))
receipt['createdAt']=created
receipt['files']=[item for item in receipt['files'] if item['path']!='catalog.json' and not item['path'].startswith(prefix)]
receipt['files'].append({'path':'catalog.json',**stamp(catalog/'catalog.json')})
receipt['files']+=({'path':prefix+path.name,**stamp(path)} for path in context_dir.iterdir())
receipt['files'].sort(key=lambda item:item['path']);write_json(receipt_path,receipt)
(catalog/'catalog.json').chmod(0o444);receipt_path.chmod(0o444)

environment={line.split('=',1)[0]:line.split('=',1)[1] for line in old['Config']['Env']}
environment['STEWARD_RELEASE_VERSION']=settings['release'];environment['STEWARD_SOURCE_REVISION']=settings['revision']
envfile=dest/'runtime.env';envfile.write_text(''.join(key+'='+value+'\n' for key,value in environment.items()));envfile.chmod(0o600)
ui=dest/'ui';ui.mkdir()
command=list(old['Config']['Cmd']);main='dev.steward.lab.LabMain'
if '-jar' in command:
    marker=command.index('-jar');jvm=command[:marker];application=command[marker+2:]
else:
    marker=command.index('-cp');main_index=command.index(main);assert marker<main_index
    jvm=command[:marker];application=command[main_index+1:]
assert application and application[0]=='serve'
release_flag=application.index('--release-version');application[release_flag+1]=settings['release']
command=jvm+['-cp','/app/steward-code.jar:/app/steward-spatial-lab.jar',main]+application

with socket.socket() as probe:probe.bind(('127.0.0.1',7083))
def start(name,port):
    return run('docker','run','-d','--name',name,'--restart','unless-stopped','--read-only',
        '--memory','3g','--cpus','2','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--tmpfs','/tmp:rw,exec,nosuid,size=512m','--env-file',str(envfile),
        '-v',str(catalog)+':/catalog:ro','-v',str(ui)+':/ui:ro','-v',str(requests_dir)+':/requests:rw',
        '-v',str(code_jar)+':/app/steward-code.jar:ro','-p','127.0.0.1:'+str(port)+':8091',
        '--entrypoint','java',base,*command)
def get(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as response:return json.load(response)
def text(port,path):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=15) as response:return response.read().decode('utf-8')
def healthy(port):
    for attempt in range(45):
        try:
            health=get(port,'/api/health')
            if health.get('status')=='ready':return health
        except (OSError,ValueError):pass
        time.sleep(1)
    raise RuntimeError('World candidate readiness timed out')
def verify(port):
    health=healthy(port);assert health['release']==settings['release']
    eras=get(port,'/api/eras');assert len(eras['eras'])==len(catalog_document['eras'])
    for era in [item for item in catalog_document['eras'] if item['status']=='ready']:
        selected_bootstrap=get(port,'/api/bootstrap?era='+era['slug'])
        assert len(selected_bootstrap['snapshots'])==1 and selected_bootstrap['snapshots'][0]['snapshotId']==era['snapshotId']
        assert selected_bootstrap['sceneAvailable'] and selected_bootstrap['terrainAvailable']==bool(era.get('contextManifest'))
        if era['slug']==settings['era']:assert selected_bootstrap['context']['heightfieldAvailable'] is True
    page=text(port,'/scene.html');assert 'data-terrain="ghost"' in page and 'Ghost preserves underground rooms' in page
    return eras

candidate='steward-world-candidate-'+settings['release'];start(candidate,7083)
try:eras=verify(7083)
finally:run('docker','rm','-f',candidate)
backup='steward-world-before-'+settings['release']
run('docker','stop','steward-world');run('docker','rename','steward-world',backup)
try:
    container=start('steward-world',7081);verify(7081)
except Exception:
    subprocess.run(['docker','rm','-f','steward-world'],capture_output=True)
    run('docker','rename',backup,'steward-world');run('docker','start','steward-world');raise
result={'release':settings['release'],'directory':str(dest),'container':container,
    'previousContainer':backup,'baseImage':base,'catalog':str(catalog),'eras':eras,
    'candidateVerified':True,'activeVerified':True,'port':7081,'uiOverride':str(ui),
    'transferredBytes':settings['bytes'],'catalogTransferred':False,'catalogClonedWithHardlinks':True,
    'terrainEra':settings['era'],'terrainSnapshot':settings['snapshotId'],'imageBuilt':False}
(dest/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
'''


if __name__ == "__main__":
    main()
