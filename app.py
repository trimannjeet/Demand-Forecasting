from math import isfinite
import os
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from sklearn.ensemble import RandomForestRegressor

from forecasting import (
    FEATURE_COLUMNS,
    FORECAST_STRATEGIES,
    MIN_HISTORY,
    MIN_TRAINING_ROWS,
    build_feature_frame,
    build_feature_row,
    evaluate_forecast_strategies,
    predict_with_strategy,
    recursive_forecast,
)

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "artifacts" / "demand_forecasting_bundle.joblib"
FRONTEND_DIST_DIR = BASE_DIR / "Frontend" / "dist"


class HealthResponse(BaseModel):
    status: str
    stores_available: int
    model_type: str
    created_at: str | None = None


class HomeResponse(BaseModel):
    message: str
    stores_available: int


class ForecastPoint(BaseModel):
    store_id: int
    forecast_date: str
    predicted_demand: float
    group_value: str | None = None


class ForecastResponse(BaseModel):
    store_id: int
    horizon_weeks: int
    group_column: str | None = None
    group_value: str | None = None
    forecasts: list[ForecastPoint]


class CustomForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date_column: str = Field(min_length=1, max_length=200)
    demand_column: str = Field(min_length=1, max_length=200)
    group_column: str | None = Field(default=None, max_length=200)
    horizon: int = Field(default=4, ge=1, le=52)
    records: list[dict[str, Any]] = Field(min_length=65, max_length=100_000)


class CustomForecastPoint(BaseModel):
    group_id: int
    group_value: str
    forecast_date: str
    predicted_demand: float


class CustomGroupMetrics(BaseModel):
    group_id: int
    group_value: str
    history_weeks: int
    mae: float | None = None
    rmse: float | None = None
    wape_percent: float | None = None
    validation_windows: int = 0
    selected_model: str = "random_forest"


class CustomForecastResponse(BaseModel):
    date_column: str
    demand_column: str
    group_column: str | None
    horizon_weeks: int
    groups_count: int
    metrics: list[CustomGroupMetrics]
    forecasts: list[CustomForecastPoint]


def load_bundle() -> dict[str, Any]:
    if not MODEL_PATH.is_file():
        raise RuntimeError(f"Model bundle not found: {MODEL_PATH}")

    loaded = joblib.load(MODEL_PATH)
    if not isinstance(loaded, dict):
        raise RuntimeError("Model bundle must contain a dictionary.")

    required_keys = {"models", "histories", "metadata", "feature_columns"}
    missing_keys = required_keys.difference(loaded)
    if missing_keys:
        raise RuntimeError(
            f"Model bundle is missing required keys: {sorted(missing_keys)}"
        )

    models = loaded["models"]
    histories = loaded["histories"]
    metadata = loaded["metadata"]
    feature_columns = loaded["feature_columns"]
    if not all(isinstance(value, dict) for value in (models, histories, metadata)):
        raise RuntimeError("Bundle models, histories, and metadata must be dictionaries.")
    if not isinstance(feature_columns, list) or not all(
        isinstance(column, str) for column in feature_columns
    ):
        raise RuntimeError("Bundle feature_columns must be a list of column names.")
    if len(feature_columns) != len(set(feature_columns)):
        raise RuntimeError("Bundle feature_columns must not contain duplicates.")

    if feature_columns != FEATURE_COLUMNS:
        raise RuntimeError(
            "Model bundle features do not match the application feature schema."
        )

    strategies = loaded.get("strategies", {})
    if not isinstance(strategies, dict):
        raise RuntimeError("Bundle strategies must be a dictionary.")

    normalized: dict[str, Any] = dict(loaded)
    normalized_strategies: dict[int, str] = {}
    for key in models:
        try:
            store_id = int(key)
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                f"Bundle strategies contain an invalid store ID: {key!r}"
            ) from error
        strategy = strategies.get(key, strategies.get(store_id, "random_forest"))
        if strategy not in FORECAST_STRATEGIES:
            raise RuntimeError(
                f"Store {store_id} has an unsupported forecast strategy: {strategy!r}"
            )
        normalized_strategies[store_id] = strategy
    normalized["strategies"] = normalized_strategies
    for name, mapping in (
        ("models", models),
        ("histories", histories),
        ("metadata", metadata),
    ):
        normalized_mapping: dict[int, Any] = {}
        for key, value in mapping.items():
            try:
                store_id = int(key)
            except (TypeError, ValueError) as error:
                raise RuntimeError(
                    f"Bundle {name} contains an invalid store ID: {key!r}"
                ) from error
            if store_id in normalized_mapping:
                raise RuntimeError(f"Bundle {name} contains duplicate store IDs.")
            normalized_mapping[store_id] = value
        normalized[name] = normalized_mapping

    store_ids = set(normalized["models"])
    if not store_ids or store_ids != set(normalized["histories"]) or store_ids != set(
        normalized["metadata"]
    ):
        raise RuntimeError(
            "Bundle models, histories, and metadata must contain the same stores."
        )

    for store_id in store_ids:
        model = normalized["models"][store_id]
        strategy = normalized["strategies"][store_id]
        if strategy == "random_forest" and not callable(
            getattr(model, "predict", None)
        ):
            raise RuntimeError(f"Store {store_id} does not have a usable model.")
        if strategy == "random_forest":
            if getattr(model, "n_features_in_", len(feature_columns)) != len(
                feature_columns
            ):
                raise RuntimeError(
                    f"Store {store_id} model has an incompatible feature count."
                )
            model_features = getattr(model, "feature_names_in_", None)
            if model_features is not None and list(model_features) != feature_columns:
                raise RuntimeError(
                    f"Store {store_id} model feature order is incompatible."
                )
        history = normalized["histories"][store_id]
        if not isinstance(history, (list, tuple)) or len(history) < MIN_HISTORY:
            raise RuntimeError(
                f"Store {store_id} must have at least {MIN_HISTORY} history values."
            )
        if not all(isfinite(float(value)) for value in history):
            raise RuntimeError(f"Store {store_id} history contains an invalid value.")
        if any(float(value) < 0 for value in history):
            raise RuntimeError(f"Store {store_id} history contains negative demand.")
        if not isinstance(normalized["metadata"][store_id], dict):
            raise RuntimeError(f"Store {store_id} metadata must be a dictionary.")
        if "latest_date" not in normalized["metadata"][store_id]:
            raise RuntimeError(f"Store {store_id} metadata has no latest_date.")
        latest_date = pd.to_datetime(
            normalized["metadata"][store_id]["latest_date"], errors="coerce"
        )
        if pd.isna(latest_date):
            raise RuntimeError(f"Store {store_id} metadata has an invalid latest_date.")

    return normalized


app = FastAPI(
    title="Demand Forecasting API",
    description="Weekly demand forecasts for multiple stores",
    version="2.0.0",
)

bundle: dict[str, Any] | None = None
bundle_error: str | None = None
bundle_attempted = False
bundle_file_signature: tuple[int, int] | None = None


def get_bundle() -> dict[str, Any] | None:
    global bundle, bundle_error, bundle_attempted, bundle_file_signature
    if bundle is not None:
        return bundle

    try:
        file_stat = MODEL_PATH.stat()
        current_signature = (file_stat.st_mtime_ns, file_stat.st_size)
    except FileNotFoundError:
        current_signature = None

    if bundle_attempted and current_signature == bundle_file_signature:
        return None

    bundle_attempted = True
    bundle_file_signature = current_signature
    try:
        bundle = load_bundle()
        bundle_error = None
    except (
        RuntimeError,
        OSError,
        EOFError,
        ValueError,
        TypeError,
        KeyError,
        ImportError,
    ) as error:
        bundle_error = str(error)
    return bundle


def require_bundle() -> dict[str, Any]:
    loaded_bundle = get_bundle()
    if loaded_bundle is None:
        raise HTTPException(
            status_code=503,
            detail=f"Saved-model forecasting is unavailable: {bundle_error}",
        )
    return loaded_bundle


cors_origins = [
    origin.strip().rstrip("/")
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/", response_model=HomeResponse, include_in_schema=False)
def serve_frontend() -> HomeResponse | FileResponse:
    index_file = FRONTEND_DIST_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    return home()


@app.get("/home", response_model=HomeResponse)
def home() -> HomeResponse:
    loaded_bundle = get_bundle()
    return HomeResponse(
        message="Demand Forecasting API is running",
        stores_available=len(loaded_bundle["models"]) if loaded_bundle else 0,
    )


@app.get("/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    loaded_bundle = get_bundle()
    model_type = loaded_bundle.get("model_type", "unknown") if loaded_bundle else "custom-only"
    created_at = loaded_bundle.get("created_at") if loaded_bundle else None
    return HealthResponse(
        status="ok",
        stores_available=len(loaded_bundle["models"]) if loaded_bundle else 0,
        model_type=model_type,
        created_at=created_at,
    )


@app.get("/stores")
def get_stores() -> dict[str, Any]:
    loaded_bundle = require_bundle()
    store_ids = sorted(loaded_bundle["models"])
    return {
        "stores": store_ids,
        "group_column": loaded_bundle.get("group_column"),
        "groups": [
            {
                "store_id": store_id,
                "value": loaded_bundle["metadata"][store_id].get("group_value"),
            }
            for store_id in store_ids
        ],
    }


@app.get("/forecast", response_model=ForecastResponse)
def get_forecast(
    store_id: int = Query(..., ge=1, description="Store ID"),
    horizon: int = Query(4, ge=1, le=52, description="Weeks to forecast"),
) -> ForecastResponse:
    loaded_bundle = require_bundle()
    if store_id not in loaded_bundle["models"]:
        raise HTTPException(
            status_code=404,
            detail=f"Store {store_id} was not found",
        )

    history = [float(value) for value in loaded_bundle["histories"][store_id]]
    latest_date = pd.Timestamp(loaded_bundle["metadata"][store_id]["latest_date"])

    model = loaded_bundle["models"][store_id]
    strategy = loaded_bundle["strategies"][store_id]
    predictions: list[ForecastPoint] = []

    for step in range(1, horizon + 1):
        forecast_date = latest_date + pd.Timedelta(weeks=step)
        try:
            features = build_feature_row(history, forecast_date)
            predicted_demand = predict_with_strategy(model, features, strategy)
        except (TypeError, ValueError, IndexError) as error:
            raise HTTPException(
                status_code=500,
                detail=f"Model could not forecast store {store_id}: {error}",
            ) from error
        if not isfinite(predicted_demand):
            raise HTTPException(
                status_code=500,
                detail=f"Model returned a non-finite prediction for store {store_id}",
            )
        predicted_demand = max(0.0, predicted_demand)
        predictions.append(
            ForecastPoint(
                store_id=store_id,
                forecast_date=forecast_date.strftime("%Y-%m-%d"),
                predicted_demand=round(predicted_demand, 2),
                group_value=loaded_bundle["metadata"][store_id].get("group_value"),
            )
        )
        history.append(predicted_demand)

    return ForecastResponse(
        store_id=store_id,
        horizon_weeks=horizon,
        group_column=loaded_bundle.get("group_column"),
        group_value=loaded_bundle["metadata"][store_id].get("group_value"),
        forecasts=predictions,
    )


@app.post("/forecast/custom", response_model=CustomForecastResponse)
def forecast_custom_dataset(
    request: CustomForecastRequest,
) -> CustomForecastResponse:
    if request.date_column == request.demand_column or (
        request.group_column is not None
        and request.group_column in (request.date_column, request.demand_column)
    ):
        raise HTTPException(
            status_code=422,
            detail="Date, demand, and group columns must be distinct.",
        )

    frame = pd.DataFrame(request.records)
    required_columns = [request.date_column, request.demand_column]
    if request.group_column is not None:
        required_columns.append(request.group_column)
    missing_columns = [
        column for column in required_columns if column not in frame.columns
    ]
    if missing_columns:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "One or more selected columns are missing from the rows.",
                "missing_columns": missing_columns,
            },
        )

    dates = pd.to_datetime(
        frame[request.date_column], errors="coerce", format="mixed", utc=True
    ).dt.tz_convert(None).dt.normalize()
    if dates.isna().any():
        raise HTTPException(
            status_code=422,
            detail=f"Column '{request.date_column}' contains a missing or invalid date.",
        )

    demand = pd.to_numeric(frame[request.demand_column], errors="coerce")
    if demand.isna().any() or not np.isfinite(demand.to_numpy(dtype=float)).all():
        raise HTTPException(
            status_code=422,
            detail=f"Column '{request.demand_column}' must contain finite numeric values.",
        )
    if (demand < 0).any():
        raise HTTPException(
            status_code=422,
            detail=f"Column '{request.demand_column}' cannot contain negative demand.",
        )

    if request.group_column is None:
        group_values = pd.Series("All data", index=frame.index, dtype="string")
    else:
        raw_groups = frame[request.group_column]
        if raw_groups.isna().any():
            raise HTTPException(
                status_code=422,
                detail=f"Column '{request.group_column}' contains a missing group value.",
            )
        group_values = raw_groups.astype("string").str.strip()
        if group_values.eq("").any():
            raise HTTPException(
                status_code=422,
                detail=f"Column '{request.group_column}' contains a blank group value.",
            )

    group_labels = sorted(group_values.unique().tolist())
    group_ids = {label: index for index, label in enumerate(group_labels, start=1)}
    data = pd.DataFrame(
        {
            "group_id": group_values.map(group_ids).astype("int64"),
            "group_value": group_values.astype(str),
            "forecast_date": dates.dt.to_period("W-SUN").dt.start_time,
            "demand": demand.astype("float64"),
        }
    )
    data = (
        data.groupby(
            ["group_id", "group_value", "forecast_date"],
            as_index=False,
            sort=True,
        )["demand"]
        .sum()
        .reset_index(drop=True)
    )
    if not np.isfinite(data["demand"].to_numpy(dtype=float)).all():
        raise HTTPException(
            status_code=422,
            detail="A weekly sales total is too large to represent as a finite number.",
        )

    grouped_data = list(data.groupby("group_id", sort=True))
    if len(grouped_data) > 500:
        raise HTTPException(
            status_code=422,
            detail="A custom forecast can contain at most 500 groups.",
        )

    forecast_points: list[CustomForecastPoint] = []
    group_metrics: list[CustomGroupMetrics] = []
    for group_id, group in grouped_data:
        numeric_group_id = int(str(group_id))
        group = group.reset_index(drop=True)
        group_value = str(group["group_value"].iloc[0])
        history = group["demand"].astype(float).tolist()
        group_dates = group["forecast_date"]

        intervals = group_dates.diff().dropna()
        if not intervals.eq(pd.Timedelta(days=7)).all():
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Group '{group_value}' must have consecutive weekly dates "
                    "with exactly seven days between rows. Missing weeks must be "
                    "added or corrected before forecasting."
                ),
            )
        minimum_training_history = MIN_HISTORY + 13
        if len(group) < minimum_training_history:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Group '{group_value}' has {len(group)} weeks; at least "
                    f"{minimum_training_history} are required to train a useful forecast."
                ),
            )

        features = build_feature_frame(history, group_dates.tolist())
        features["target"] = history
        trainable = features.dropna(subset=FEATURE_COLUMNS + ["target"])
        metrics = CustomGroupMetrics(
            group_id=numeric_group_id,
            group_value=group_value,
            history_weeks=len(group),
        )

        minimum_for_metrics = MIN_TRAINING_ROWS + request.horizon
        selected_strategy = "random_forest"
        if len(group) >= minimum_for_metrics:
            try:
                evaluation = evaluate_forecast_strategies(
                    history,
                    group_dates,
                    request.horizon,
                    lambda: RandomForestRegressor(
                        n_estimators=100,
                        min_samples_leaf=2,
                        random_state=42,
                        n_jobs=-1,
                    ),
                )
            except (ValueError, TypeError) as error:
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not backtest group '{group_value}': {error}",
                ) from error
            metrics.mae = float(evaluation["mae"])
            metrics.rmse = float(evaluation["rmse"])
            metrics.wape_percent = (
                float(evaluation["wape_percent"])
                if evaluation["wape_percent"] is not None
                else None
            )
            metrics.validation_windows = int(evaluation["validation_windows"])
            selected_strategy = str(evaluation["selected_model"])

        model = None
        if selected_strategy == "random_forest":
            model = RandomForestRegressor(
                n_estimators=100,
                min_samples_leaf=2,
                random_state=42,
                n_jobs=-1,
            )
            model.fit(trainable[FEATURE_COLUMNS], trainable["target"])
        metrics.selected_model = selected_strategy
        group_metrics.append(metrics)

        latest_date = pd.Timestamp(group_dates.iloc[-1])
        try:
            group_predictions = recursive_forecast(
                model, history, latest_date, request.horizon, selected_strategy
            )
        except (ValueError, TypeError, IndexError) as error:
            raise HTTPException(
                status_code=500,
                detail=f"Could not forecast group '{group_value}': {error}",
            ) from error
        for step, prediction in enumerate(group_predictions, start=1):
            if not isfinite(prediction):
                raise HTTPException(
                    status_code=500,
                    detail=f"Model produced an invalid prediction for group '{group_value}'.",
                )
            forecast_date = latest_date + pd.Timedelta(weeks=step)
            forecast_points.append(
                CustomForecastPoint(
                    group_id=numeric_group_id,
                    group_value=group_value,
                    forecast_date=forecast_date.strftime("%Y-%m-%d"),
                    predicted_demand=round(prediction, 2),
                )
            )

    return CustomForecastResponse(
        date_column=request.date_column,
        demand_column=request.demand_column,
        group_column=request.group_column,
        horizon_weeks=request.horizon,
        groups_count=len(grouped_data),
        metrics=group_metrics,
        forecasts=forecast_points,
    )


if (FRONTEND_DIST_DIR / "assets").is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=FRONTEND_DIST_DIR / "assets"),
        name="frontend-assets",
    )
