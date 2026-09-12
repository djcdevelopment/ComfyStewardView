import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
SPEC=importlib.util.spec_from_file_location('deploy_world_era',ROOT/'deploy_world_era.py')
MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)


class DeployWorldEraTests(unittest.TestCase):
    def package(self,root):
        era=root/'era16';context=era/'context';artifacts=era/'artifacts'/'1008'
        context.mkdir(parents=True);artifacts.mkdir(parents=True)
        for path,data in ((era/'public.duckdb',b'db'),(context/'manifest.json',b'context'),
                          (artifacts/'manifest.json',b'raster')):path.write_bytes(data)
        record=lambda path:{'path':path.relative_to(root).as_posix(),'bytes':path.stat().st_size,
                            'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
        files=[record(path) for path in sorted(era.rglob('*')) if path.is_file()]
        entry={'slug':'era16','status':'ready','snapshotId':1008,'cache':'era16/public.duckdb',
               'contextManifest':'era16/context/manifest.json','artifacts':'era16/artifacts','files':files}
        (root/'entry.json').write_text(json.dumps(entry),encoding='utf-8')
        receipt={'schema':'steward-world-era-package/v1','era':'era16','snapshotId':1008,
                 'entry':entry,'files':files}
        (root/'receipt.json').write_text(json.dumps(receipt),encoding='utf-8')

    def test_accepts_complete_incremental_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.package(root)
            receipt,entry=MODULE.validate_package(root)
            self.assertEqual('era16',receipt['era']);self.assertEqual(1008,entry['snapshotId'])

    def test_rejects_package_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.package(root);(root/'era16'/'extra').write_bytes(b'x')
            with self.assertRaisesRegex(ValueError,'file set drift'):MODULE.validate_package(root)

    def test_remote_program_compiles_and_avoids_image_build(self):
        compile(MODULE.REMOTE,'<deploy-world-era-remote>','exec')
        self.assertIn('copy_function=os.link',MODULE.REMOTE)
        self.assertIn("'catalogTransferred':False",MODULE.REMOTE)
        self.assertIn("'imageBuilt':False",MODULE.REMOTE)
        self.assertNotIn("docker','build",MODULE.REMOTE)


if __name__=='__main__':unittest.main()
