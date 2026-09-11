#!/usr/bin/env python3
"""Freeze already-local AM4 inputs for a campaign. Does not launch the game."""
import argparse
from pathlib import Path
import shutil
from capture_worker import read, stamp, verify, write


def install(args):
    root=args.root.resolve();game=args.game.resolve();plan=read(root/'campaign.json')
    if (root/'runtime.json').exists():raise ValueError('Campaign already installed')
    if root==game or root.is_relative_to(game):raise ValueError('Campaign must be outside the game install')
    source=root/'source';source.mkdir()
    sources={}
    for kind,path in (('db',args.source_db),('fwl',args.source_fwl),('character',args.character_file)):
        expected=plan['sourceFiles'][kind] if kind in ('db','fwl') else stamp(path)
        verify(path,expected)
        filename=plan['world']+'.'+kind if kind in ('db','fwl') else path.name
        target=source/filename;shutil.copy2(path,target);verify(target,expected)
        target.chmod(0o444);sources[kind]={'path':str(target),**expected}
    launch=read(args.verified_launch)
    if launch['runtimeMode']!='current-client':raise ValueError('Expected verified current-client launch')
    plugins={}
    for item in launch['files']:
        path=Path(item['path'])
        if path.suffix=='.dll':
            if path.parent.resolve()!=game/'BepInEx/plugins':raise ValueError('Plugin install differs from proof')
            verify(path,item);plugins[path.name]={k:item[k] for k in ('bytes','sha256')}
    if set(plugins)!={'ComfyCameraProof.dll','BetterServerPortals.dll'}:raise ValueError('Capture plugin proof incomplete')
    caches=[]
    for suffix in ('mapTexCache','heightTexCache','forestMaskTexCache'):
        path=args.terrain_root/(plan['world']+'_'+suffix)
        target=source/path.name;shutil.copy2(path,target);verify(target,stamp(path));target.chmod(0o444)
        caches.append({'path':str(target),**stamp(target)})
    runtime_files=[]
    for relative in ('valheim.x86_64','UnityPlayer.so','valheim_Data/Managed/assembly_valheim.dll',
                     'valheim_Data/Managed/assembly_utils.dll','start_game_bepinex.sh'):
        path=game/relative;runtime_files.append({'path':str(path),**stamp(path)})
    runtime={'sourceKey':plan['sourceKey'],'campaign':stamp(root/'campaign.json'),'gameRoot':str(game),
             'sources':sources,'plugins':plugins,'terrainCaches':caches,'runtimeFiles':runtime_files,
             'character':args.character_file.stem,'runtimeMode':'current-client','verifiedLaunch':stamp(args.verified_launch)}
    # The renderer is part of the measurement. Freeze the operator's PlayerPrefs so
    # every attempt runs the same graphics (and, on 1.0, skips the intro), and record
    # the game build so two eras shot on different clients can never be mistaken for
    # the same instrument.
    if args.prefs:
        target=source/'prefs';shutil.copy2(args.prefs,target);verify(target,stamp(args.prefs));target.chmod(0o444)
        runtime['prefs']={'path':str(target),**stamp(target)}
    manifest=game/'steamapps/appmanifest_892970.acf'
    if manifest.exists():
        import re
        m=re.search(r'"buildid"\s*"(\d+)"',manifest.read_text(encoding='utf-8',errors='replace'))
        if m:runtime['gameBuild']=m.group(1)
    write(root/'runtime.json',runtime)
    print('Installed local campaign: '+str(root))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('root','game','source-db','source-fwl','character-file','terrain-root','verified-launch'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--prefs',type=Path,default=None,
                        help='Unity PlayerPrefs file to seed into every attempt '
                             '(~/.config/unity3d/IronGate/Valheim/prefs). Without it '
                             'each launch runs on Unity defaults and, on 1.0, plays the intro.')
    install(parser.parse_args())
