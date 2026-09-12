import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
SPEC=importlib.util.spec_from_file_location('prepare_world_era',ROOT/'prepare_world_era.py')
MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)


class PrepareWorldEraTests(unittest.TestCase):
    def test_refuses_an_existing_destination_before_reading_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            with self.assertRaisesRegex(ValueError,'new immutable era package'):
                MODULE.prepare(root,root/'missing.json','era16',root)


if __name__=='__main__':unittest.main()
