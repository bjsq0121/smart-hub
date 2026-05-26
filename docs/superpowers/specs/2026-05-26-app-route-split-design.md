# App Route Split Design

## Goal

Reduce `app.py` size and blast radius by moving stock and coin route registration into focused modules without changing URLs, auth behavior, Firestore collections, or deployment shape.

## Scope

This first slice is a behavior-preserving refactor. It does not change trading rules, API contracts, frontend code, Firebase Hosting rewrites, Cloud Run settings, or Firestore schema.

## Approach

Use FastAPI routers for stock and coin API surfaces, but keep shared state and helper functions in `app.py` during this first slice. Each extracted module receives the dependency functions and constants it needs through explicit registration, avoiding a large shared-context migration in the same change.

The split targets:

- Stock route registration for `/api/stock/**`, `/api/autotrade/**`, `/api/stock-signals/**`, and related stock operation endpoints.
- Coin route registration for `/api/coin/**`, `/api/backtest/**`, `/api/signals`, `/api/paper-trades`, `/api/trade-results`, `/api/performance/**`, and related coin operation endpoints.

## Boundaries

`app.py` remains responsible for:

- `FastAPI()` construction and middleware.
- Static file mounting.
- Auth and webhook secret verification.
- Shared Firestore client access.
- Shared KIS, Upbit, Vertex, and normalization helpers until later slices.

New modules are responsible for:

- Grouping route definitions by domain.
- Registering routers onto the main app.
- Keeping route paths and dependency behavior identical.

## Testing

Add tests that import the app and assert representative stock and coin routes are still registered. Run the existing `unittest` suite to ensure the current helper-level tests continue to pass.

## Follow-Up Slices

After route extraction is stable:

1. Move pure stock helpers and models into stock modules.
2. Move pure coin helpers and models into coin modules.
3. Move shared auth, Firestore, and external API clients into `smart_hub/core`.
4. Update deployment docs once `app.py` becomes a thin composition root.
