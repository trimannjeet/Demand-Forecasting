export interface HealthResponse { status: string; stores_available: number; model_type: string; created_at?: string | null }
export interface HomeResponse { message: string; stores_available: number }
export interface StoreGroup { store_id: number; value: string | null }
export interface StoresResponse { stores: number[]; group_column: string | null; groups: StoreGroup[] }
export interface ForecastPoint { store_id: number; forecast_date: string; predicted_demand: number; group_value: string | null }
export interface ForecastResponse { store_id: number; horizon_weeks: number; group_column: string | null; group_value: string | null; forecasts: ForecastPoint[] }
export interface CustomForecastRequest { date_column: string; demand_column: string; group_column: string | null; horizon: number; records: Record<string, unknown>[] }
export interface CustomForecastPoint { group_id: number; group_value: string; forecast_date: string; predicted_demand: number }
export interface CustomGroupMetrics { group_id: number; group_value: string; history_weeks: number; mae: number | null; rmse: number | null; wape_percent: number | null; validation_windows: number; selected_model: string }
export interface CustomForecastResponse { date_column: string; demand_column: string; group_column: string | null; horizon_weeks: number; groups_count: number; metrics: CustomGroupMetrics[]; forecasts: CustomForecastPoint[] }
export interface ApiErrorBody { detail?: string | { message?: string; missing_columns?: string[] } | Array<{ loc?: (string | number)[]; msg?: string; type?: string }> }
