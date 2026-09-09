import contextlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from capture_worker import stamp
from stage_worlds import REMOTE


class StagingTests(unittest.TestCase):
    def prepare(self, root, extra=False):
        source=root/'originals';source.mkdir()
        remote=root/'remote';remote.mkdir()
        era={'slug':'era7','sourceKey':'a'*64,'worldId':'ComfyEra7'}
        for kind in ('db','fwl'):
            path=source/('ComfyEra7.'+kind);path.write_bytes((kind*100).encode())
            era[kind]={**stamp(path),'name':path.name}
        package=remote/'test.tgz'
        with tarfile.open(package,'w:gz') as bundle:
            for path in source.iterdir():bundle.add(path,arcname=path.name)
            if extra:bundle.add(source/'ComfyEra7.db',arcname='../escape.db')
        return {'root':str(remote),'era':era,'operation':'install','package':{**stamp(package),'name':package.name}}

    def run_remote(self, settings):
        output=io.StringIO()
        with contextlib.redirect_stdout(output):exec(REMOTE,{'settings':settings})
        return json.loads(output.getvalue())

    def test_pair_is_verified_before_ready_and_rerun_preserves_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);settings=self.prepare(root)
            result=self.run_remote(settings)
            self.assertEqual('verified',result['status'])
            ready=Path(result['directory'])
            self.assertTrue((ready/'receipt.json').is_file())
            for kind in ('db','fwl'):
                self.assertEqual(stamp(root/'originals'/settings['era'][kind]['name']),
                                 stamp(ready/settings['era'][kind]['name']))
            self.assertFalse((root/'remote'/'test.tgz').exists())
            self.assertEqual('verified-existing',self.run_remote({**settings,'operation':'probe'})['status'])

    def test_transport_or_source_mismatch_never_publishes_pair(self):
        for corrupt in ('transport','source'):
            with self.subTest(corrupt=corrupt),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);settings=self.prepare(root)
                if corrupt=='transport':settings['package']['sha256']='0'*64
                else:settings['era']['db']['sha256']='0'*64
                with self.assertRaises(AssertionError):self.run_remote(settings)
                self.assertFalse((root/'remote'/('era7-'+'a'*64)).exists())
                self.assertTrue((root/'originals'/'ComfyEra7.db').exists())

    def test_unexpected_archive_member_is_rejected_without_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);settings=self.prepare(root,extra=True)
            with self.assertRaisesRegex(AssertionError,'Unexpected archive members'):self.run_remote(settings)
            self.assertFalse((root/'remote'/('era7-'+'a'*64)).exists())
            self.assertFalse((root/'remote'/'escape.db').exists())


if __name__=='__main__':unittest.main()
