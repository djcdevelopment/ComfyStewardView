#!/usr/bin/env python3
"""Bind an observed current-client terrain generation receipt to its context package."""
import argparse
from pathlib import Path
from archive import digest, load, save


def annotate(context, receipt):
    manifest=load(context);generation=load(receipt)
    if generation.get('schema')!='steward-terrain-generation/v1' or generation.get('mode')!='current-client':
        raise ValueError('Unsupported terrain generation receipt')
    if generation['sourceDbSha256']!=manifest['snapshot']['sha256']:raise ValueError('Generation snapshot mismatch')
    for name,spec in manifest['sources'].items():
        if generation['sources'].get(name)!=spec['sha256']:raise ValueError('Generation cache mismatch: '+name)
    manifest['generation']={k:generation[k] for k in ('mode','gameVersion','sourceDbSha256')}
    manifest['generation']['receiptSha256']=digest(receipt)['sha256']
    save(context,manifest)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context',type=Path,required=True);parser.add_argument('--receipt',type=Path,required=True)
    args=parser.parse_args();annotate(args.context,args.receipt)
