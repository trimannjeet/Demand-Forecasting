# DemandStudio

A store-demand forecasting project with a React dashboard, FastAPI backend, and a configurable model-training notebook. Upload a sales CSV to explore historical demand, compare stores, and forecast upcoming weekly demand.

## Project layout

```text
.
├── app.py                     # FastAPI application
├── forecasting.py             # Shared features, forecasts, and backtesting
├── generate_dataset.ipynb     # Train/evaluate models from a local CSV
├── requirements.txt           # Backend runtime dependencies
├── requirements-dev.txt       # Backend test dependencies
├── data/                      # Private/local CSV datasets (not committed)
├── artifacts/                 # Generated model bundles (not committed)
├── tests/
│   └── test_forecasting_api.py
├── Frontend/
│   ├── src/
│   └── package.json
└── .github/workflows/ci.yml   # Backend and frontend checks
```

Datasets, trained model bundles, environment files, caches, and compiled frontend assets are intentionally excluded from Git. Place local training CSVs in `data/`; the notebook writes its optional saved-model bundle and forecast exports to `artifacts/`. Neither a dataset nor a pre-trained bundle is required for forecasts from uploaded CSV files.

## Requirements

- Python 3.11
- Node.js 20+ and npm

## Run locally

Install backend dependencies from the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Start the API in one PowerShell terminal:

```powershell
python -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in a second terminal:

```powershell
Set-Location .\Frontend
npm ci
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173`). The development server proxies `/api` requests to FastAPI on port 8000. API health and interactive docs are at `http://127.0.0.1:8000/health` and `http://127.0.0.1:8000/docs`.

The frontend defaults to the local `/api` proxy. If you need another API base URL, create `Frontend/.env.local` with `VITE_API_BASE_URL=<your-api-base-url>`. Never commit `.env.local` or put secrets in frontend `VITE_*` variables.

## Deploy as one website

The root `Dockerfile` builds the frontend and runs it alongside the FastAPI API in
one service, so the dashboard and API share one public URL. To deploy on Render,
create a **Web Service** from this GitHub repository, select **Docker** as the
runtime, and leave the Dockerfile path as `./Dockerfile`. Render builds and starts
the service from that file; no separate static site or API service is needed.
The service's `/` path serves the dashboard, and `/health` checks the API.

Forecasting from uploaded CSV files works without a saved model. To use the
optional saved-model endpoints after deployment, generate
`artifacts/demand_forecasting_bundle.joblib` from your own dataset and include it
in the deployment image; datasets and model artifacts remain excluded from Git.

## Use your own data

Upload a CSV from the dashboard. Alternatively, place a local training CSV in `data/` and set `DATA_FILE`, `DATE_COLUMN`, `DEMAND_COLUMN`, and the optional `GROUP_COLUMN` in the notebook's first code cell.

The forecasting pipeline aggregates daily transactions to Monday-start weekly totals. Each store/group needs at least 65 consecutive weekly observations, with no missing weeks. CSV inputs can contain up to 100,000 records and 500 groups. `/forecast/custom` does not require a model artifact.

The notebook creates `artifacts/demand_forecasting_bundle.joblib` for the optional saved-model endpoints (`/stores` and `GET /forecast`). This generated file is deliberately ignored by Git; rerun the notebook after cloning if those endpoints are needed.

The forecast uses demand history and calendar features only. Promotions, planned holidays, prices, weather, and other future variables are not currently modeled. Backtest performance measures historical results and does not guarantee future accuracy.

Keep private or third-party data local. Data files and generated artifacts are excluded from Git; the notebook's output bundle can be recreated from a local dataset.

## Validate changes

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
Set-Location .\Frontend
npm ci
npm run build
```

These checks also run in GitHub Actions on pushes and pull requests to the repository.
