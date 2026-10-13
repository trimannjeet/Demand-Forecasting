from __future__ import annotations

import unittest
import joblib
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import pandas as pd
from fastapi.testclient import TestClient

import app
from forecasting import build_feature_frame


class LagModel:
    def __init__(self, **_: object) -> None:
        pass

    def fit(self, *_: object) -> LagModel:
        return self

    def predict(self, features: pd.DataFrame) -> object:
        return features["lag_1"].to_numpy()


class CustomForecastApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app.app)
        self.original_bundle = app.bundle
        self.original_bundle_error = app.bundle_error
        self.original_bundle_attempted = app.bundle_attempted
        self.original_bundle_file_signature = app.bundle_file_signature
        app.bundle = None
        app.bundle_error = None
        app.bundle_attempted = False
        app.bundle_file_signature = None

    def tearDown(self) -> None:
        self.client.close()
        app.bundle = self.original_bundle
        app.bundle_error = self.original_bundle_error
        app.bundle_attempted = self.original_bundle_attempted
        app.bundle_file_signature = self.original_bundle_file_signature

    def test_home_endpoint_is_available_at_home_path(self) -> None:
        with patch("app.get_bundle", return_value=None):
            response = self.client.get("/home")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"message": "Demand Forecasting API is running", "stores_available": 0},
        )

    def test_root_serves_frontend_when_built(self) -> None:
        with TemporaryDirectory() as directory:
            index_file = Path(directory) / "index.html"
            index_file.write_text("<!doctype html><title>DemandStudio</title>")
            with patch.object(app, "FRONTEND_DIST_DIR", Path(directory)):
                response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("DemandStudio", response.text)

    @staticmethod
    def records(weeks: int, skip_week: int | None = None) -> list[dict[str, object]]:
        first_monday = pd.Timestamp("2020-01-06")
        rows: list[dict[str, object]] = []
        for week in range(weeks):
            if week == skip_week:
                continue
            for day, sales in ((0, 2), (4, 3)):
                rows.append(
                    {
                        "date": (first_monday + pd.Timedelta(weeks=week, days=day))
                        .date()
                        .isoformat(),
                        "sales": sales,
                        "store": "Store A",
                    }
                )
        return rows

    def forecast(self, weeks: int, skip_week: int | None = None):
        return self.client.post(
            "/forecast/custom",
            json={
                "date_column": "date",
                "demand_column": "sales",
                "group_column": "store",
                "horizon": 4,
                "records": self.records(weeks, skip_week),
            },
        )

    def test_sums_multiple_sales_rows_into_monday_weeks(self) -> None:
        with patch("app.RandomForestRegressor", LagModel):
            response = self.forecast(65)

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["metrics"][0]["history_weeks"], 65)
        self.assertEqual([point["predicted_demand"] for point in body["forecasts"]], [5] * 4)
        self.assertEqual(body["forecasts"][0]["forecast_date"], "2021-04-05")

    def test_rejects_history_with_too_few_training_examples(self) -> None:
        response = self.forecast(64)

        self.assertEqual(response.status_code, 422)
        self.assertIn("at least 65", response.json()["detail"])

    def test_backtest_matches_requested_horizon_when_history_is_sufficient(self) -> None:
        with patch("app.RandomForestRegressor", LagModel):
            response = self.forecast(69)

        self.assertEqual(response.status_code, 200, response.text)
        metrics = response.json()["metrics"][0]
        self.assertEqual(metrics["wape_percent"], 0)
        self.assertEqual(metrics["validation_windows"], 1)
        self.assertEqual(metrics["selected_model"], "random_forest")

    def test_backtest_uses_multiple_rolling_windows_when_history_allows(self) -> None:
        with patch("app.RandomForestRegressor", LagModel):
            response = self.forecast(95)

        self.assertEqual(response.status_code, 200, response.text)
        metrics = response.json()["metrics"][0]
        self.assertEqual(metrics["validation_windows"], 3)
        self.assertEqual(metrics["wape_percent"], 0)

    def test_feature_frame_aligns_dates_with_nonzero_series_indexes(self) -> None:
        dates = pd.Series(
            pd.date_range("2020-01-06", periods=65, freq="7D"),
            index=range(200, 265),
        )

        features = build_feature_frame([5.0] * 65, dates)

        self.assertFalse(features[["month", "quarter", "week_of_year"]].isna().any().any())
        self.assertEqual(features.loc[52, "month"], 1)

    def test_rejects_a_missing_week_after_aggregation(self) -> None:
        response = self.forecast(67, skip_week=10)

        self.assertEqual(response.status_code, 422)
        self.assertIn("consecutive weekly dates", response.json()["detail"])

    def test_custom_forecast_does_not_require_saved_bundle(self) -> None:
        with patch("app.load_bundle", side_effect=RuntimeError("bundle unavailable")):
            health = self.client.get("/health")
            saved_forecast = self.client.get("/forecast?store_id=1")

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["model_type"], "custom-only")
        self.assertEqual(saved_forecast.status_code, 503)

    def test_bundle_load_retries_after_artifact_is_created(self) -> None:
        with TemporaryDirectory() as directory:
            bundle_path = Path(directory) / "bundle.joblib"
            with (
                patch.object(app, "MODEL_PATH", bundle_path),
                patch(
                    "app.load_bundle",
                    side_effect=[RuntimeError("bundle not found"), {"ready": True}],
                ) as load_bundle,
            ):
                self.assertIsNone(app.get_bundle())
                bundle_path.write_bytes(b"created")

                self.assertEqual(app.get_bundle(), {"ready": True})

        self.assertEqual(load_bundle.call_count, 2)

    def test_saved_forecast_bundle_supports_selected_seasonal_strategy(self) -> None:
        with TemporaryDirectory() as directory:
            bundle_path = Path(directory) / "bundle.joblib"
            joblib.dump(
                {
                    "models": {1: None},
                    "histories": {1: [float(value) for value in range(1, 66)]},
                    "metadata": {
                        1: {"latest_date": "2021-04-05", "group_value": "Store A"}
                    },
                    "strategies": {1: "seasonal_52"},
                    "feature_columns": app.FEATURE_COLUMNS,
                },
                bundle_path,
            )
            with patch.object(app, "MODEL_PATH", bundle_path):
                loaded = app.load_bundle()

        with patch("app.require_bundle", return_value=loaded):
            response = self.client.get("/forecast?store_id=1&horizon=4")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [point["predicted_demand"] for point in response.json()["forecasts"]],
            [14, 15, 16, 17],
        )


if __name__ == "__main__":
    unittest.main()
