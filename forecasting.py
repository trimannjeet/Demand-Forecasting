from math import isfinite
from typing import Any, Callable, Sequence, TypedDict

import pandas as pd

MIN_HISTORY = 52
MIN_TRAINING_ROWS = MIN_HISTORY + 13
MAX_BACKTEST_WINDOWS = 4
FEATURE_COLUMNS = [
    "lag_1",
    "lag_2",
    "lag_3",
    "lag_4",
    "lag_8",
    "lag_12",
    "lag_26",
    "lag_52",
    "rolling_mean_4",
    "rolling_mean_8",
    "rolling_mean_12",
    "month",
    "quarter",
    "week_of_year",
]
FORECAST_STRATEGIES = (
    "random_forest",
    "seasonal_52",
    "recent_mean_4",
)


class ForecastEvaluation(TypedDict):
    selected_model: str
    mae: float
    rmse: float
    wape_percent: float | None
    validation_windows: int


def build_feature_row(
    history: Sequence[float], forecast_date: pd.Timestamp
) -> dict[str, float | int]:
    if len(history) < MIN_HISTORY:
        raise ValueError(
            f"At least {MIN_HISTORY} weekly observations are required."
        )
    if not all(isfinite(float(value)) for value in history[-MIN_HISTORY:]):
        raise ValueError("History must contain only finite values.")

    return {
        "lag_1": float(history[-1]),
        "lag_2": float(history[-2]),
        "lag_3": float(history[-3]),
        "lag_4": float(history[-4]),
        "lag_8": float(history[-8]),
        "lag_12": float(history[-12]),
        "lag_26": float(history[-26]),
        "lag_52": float(history[-52]),
        "rolling_mean_4": sum(history[-4:]) / 4,
        "rolling_mean_8": sum(history[-8:]) / 8,
        "rolling_mean_12": sum(history[-12:]) / 12,
        "month": forecast_date.month,
        "quarter": forecast_date.quarter,
        "week_of_year": int(forecast_date.isocalendar().week),
    }


def build_feature_frame(
    demand: Sequence[float], dates: Sequence[pd.Timestamp] | pd.Series
) -> pd.DataFrame:
    if len(demand) != len(dates):
        raise ValueError("Demand and date sequences must have the same length.")

    values = pd.Series(demand, dtype="float64")
    timestamps = pd.Series(pd.to_datetime(dates, errors="coerce")).reset_index(
        drop=True
    )
    if values.isna().any() or not values.map(isfinite).all():
        raise ValueError("Demand must contain only finite numeric values.")
    if timestamps.isna().any():
        raise ValueError("Dates must contain only valid timestamps.")

    features = pd.DataFrame(index=values.index)
    for lag in (1, 2, 3, 4, 8, 12, 26, 52):
        features[f"lag_{lag}"] = values.shift(lag)
    prior_values = values.shift(1)
    for window in (4, 8, 12):
        features[f"rolling_mean_{window}"] = prior_values.rolling(window).mean()
    features["month"] = timestamps.dt.month
    features["quarter"] = timestamps.dt.quarter
    features["week_of_year"] = timestamps.dt.isocalendar().week.astype("float64")
    return features[FEATURE_COLUMNS]


def predict_with_strategy(
    model: Any | None,
    feature_row: dict[str, float | int],
    strategy: str,
) -> float:
    if strategy == "seasonal_52":
        return float(feature_row["lag_52"])
    if strategy == "recent_mean_4":
        return float(feature_row["rolling_mean_4"])
    if strategy != "random_forest" or model is None:
        raise ValueError(f"Unsupported or unavailable forecast strategy: {strategy}")
    features = pd.DataFrame([feature_row], columns=FEATURE_COLUMNS)
    return float(model.predict(features)[0])


def recursive_forecast(
    model: Any | None,
    history: Sequence[float],
    latest_date: pd.Timestamp,
    horizon: int,
    strategy: str,
) -> list[float]:
    forecast_history = [float(value) for value in history]
    predictions: list[float] = []
    for step in range(1, horizon + 1):
        forecast_date = latest_date + pd.Timedelta(weeks=step)
        feature_row = build_feature_row(forecast_history, forecast_date)
        prediction = predict_with_strategy(model, feature_row, strategy)
        if not isfinite(prediction):
            raise ValueError("Forecast strategy produced a non-finite prediction.")
        prediction = max(0.0, prediction)
        predictions.append(prediction)
        forecast_history.append(prediction)
    return predictions


def evaluate_forecast_strategies(
    history: Sequence[float],
    dates: Sequence[pd.Timestamp],
    horizon: int,
    model_factory: Callable[[], Any],
) -> ForecastEvaluation:
    if len(history) != len(dates):
        raise ValueError("Demand and date sequences must have the same length.")
    if horizon < 1:
        raise ValueError("Forecast horizon must be positive.")

    values = [float(value) for value in history]
    timestamps = pd.Series(pd.to_datetime(dates, errors="coerce"))
    if timestamps.isna().any():
        raise ValueError("Dates must contain only valid timestamps.")
    latest_origin = len(values) - horizon
    minimum_origin = MIN_TRAINING_ROWS
    if latest_origin < minimum_origin:
        raise ValueError("Not enough history for a horizon-matched backtest.")

    step = max(13, horizon)
    origins = [
        latest_origin - step * offset
        for offset in reversed(range(MAX_BACKTEST_WINDOWS))
        if latest_origin - step * offset >= minimum_origin
    ]
    feature_frame = build_feature_frame(values, timestamps)
    feature_frame["target"] = values
    trainable = feature_frame.dropna(subset=FEATURE_COLUMNS + ["target"])
    selection_errors = {strategy: 0.0 for strategy in FORECAST_STRATEGIES}
    selected_errors: list[float] = []
    selected_squared_errors: list[float] = []
    selected_actual: list[float] = []
    forest_errors: list[float] = []
    forest_squared_errors: list[float] = []

    for origin in origins:
        training_rows = trainable.loc[trainable.index < origin]
        if len(training_rows) < 13:
            raise ValueError("Backtest fold has too few supervised training examples.")
        model = model_factory().fit(
            training_rows[FEATURE_COLUMNS], training_rows["target"]
        )
        fold_actual = values[origin : origin + horizon]
        fold_predictions: dict[str, list[float]] = {}
        for strategy in FORECAST_STRATEGIES:
            fold_predictions[strategy] = recursive_forecast(
                model if strategy == "random_forest" else None,
                values[:origin],
                timestamps.iloc[origin - 1],
                horizon,
                strategy,
            )

        chosen_strategy = min(
            FORECAST_STRATEGIES,
            key=lambda strategy: selection_errors[strategy],
        )
        if not any(selection_errors.values()):
            chosen_strategy = "random_forest"
        chosen_predictions = fold_predictions[chosen_strategy]
        fold_errors = [
            actual - predicted
            for actual, predicted in zip(fold_actual, chosen_predictions)
        ]
        selected_errors.extend(abs(error) for error in fold_errors)
        selected_squared_errors.extend(error * error for error in fold_errors)
        selected_actual.extend(fold_actual)
        forest_fold_errors = [
            actual - predicted
            for actual, predicted in zip(
                fold_actual, fold_predictions["random_forest"]
            )
        ]
        forest_errors.extend(abs(error) for error in forest_fold_errors)
        forest_squared_errors.extend(error * error for error in forest_fold_errors)

        for strategy, predictions in fold_predictions.items():
            selection_errors[strategy] += sum(
                abs(actual - predicted)
                for actual, predicted in zip(fold_actual, predictions)
            )

    selected_strategy = min(
        FORECAST_STRATEGIES,
        key=lambda strategy: selection_errors[strategy],
    )
    use_selected_strategy = sum(selected_errors) < sum(forest_errors)
    if not use_selected_strategy:
        selected_strategy = "random_forest"
    reported_errors = selected_errors if use_selected_strategy else forest_errors
    reported_squared_errors = (
        selected_squared_errors if use_selected_strategy else forest_squared_errors
    )
    absolute_total = sum(reported_errors)
    actual_total = sum(abs(value) for value in selected_actual)
    return {
        "selected_model": selected_strategy,
        "mae": absolute_total / len(reported_errors),
        "rmse": (sum(reported_squared_errors) / len(reported_errors)) ** 0.5,
        "wape_percent": 100 * absolute_total / actual_total if actual_total else None,
        "validation_windows": len(origins),
    }
