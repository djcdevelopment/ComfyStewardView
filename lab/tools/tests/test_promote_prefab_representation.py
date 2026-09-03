import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).parents[1] / "promote-prefab-representation.py"
SPEC = importlib.util.spec_from_file_location("promotion", MODULE_PATH)
promotion = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(promotion)


class PromotionGateTest(unittest.TestCase):
    def rows(self, holdout_delta=0.20):
        result = []
        for role, cluster in (("tuning", 713), ("holdout", 1364)):
            for index in range(3):
                baseline = 0.30
                result.append({
                    "prefab": "windmill", "role": role, "fixture": cluster,
                    "viewId": f"{cluster}-{index}", "usable": True,
                    "baselineSilhouetteIou": baseline,
                    "candidateSilhouetteIou": baseline + (holdout_delta if role == "holdout" else 0.22),
                    "depthPairs": 700, "candidateDepthOrdering": 0.86,
                })
        return result

    def test_passes_all_declared_gates(self):
        passed, failures, summary = promotion.assess(
            {"schema": "steward-prefab-fidelity-metrics/v1", "views": self.rows()}, "windmill")
        self.assertTrue(passed, failures)
        self.assertEqual(3, summary["holdoutViews"])

    def test_holdout_regression_blocks_promotion(self):
        rows = self.rows()
        rows[-1]["candidateSilhouetteIou"] = 0.20
        passed, failures, _ = promotion.assess(
            {"schema": "steward-prefab-fidelity-metrics/v1", "views": rows}, "windmill")
        self.assertFalse(passed)
        self.assertTrue(any("regresses" in value for value in failures))

    def test_missing_depth_evidence_blocks_promotion(self):
        rows = self.rows()
        for row in rows:
            row["depthPairs"] = 0
            row["candidateDepthOrdering"] = None
        passed, failures, summary = promotion.assess(
            {"schema": "steward-prefab-fidelity-metrics/v1", "views": rows}, "windmill")
        self.assertFalse(passed)
        self.assertEqual(0, summary["depthQualifiedViews"])
        self.assertTrue(any("depth-qualified" in value for value in failures))


if __name__ == "__main__":
    unittest.main()
