"""
Feature Engineering
-------------------
Provides a `FeaturePipeline` that eliminates all forms of data leakage:

  1. Normalization parameters are FIT on training data, then APPLIED to test/live
     data using the exact same min/max — test-set statistics never contaminate
     training-time scaling.

  2. Categorical label encoders are FIT on training data; unknown labels seen at
     test/inference time are mapped to index 0 (safe fallback).

  3. Rolling statistics (EMA win rates, ELO, recent form) are computed using
     .shift(1) so no current-race outcome ever leaks into the input features.

Usage
-----
# Training
pipeline  = FeaturePipeline()
feat_train = pipeline.fit_transform(train_df)

# Test / backtest (pass history_df so rolling stats can warm up)
feat_test = pipeline.transform(test_df, history_df=train_df)

# Live (single race — history is the full historical feature DataFrame)
feat_live = pipeline.transform(race_df, history_df=full_history_df)
"""

import math
import pickle
import numpy as np
import pandas as pd
from typing import Dict, Optional


# ── ELO hyper-parameters ──────────────────────────────────────────────────────
ELO_K_HORSE   = 32
ELO_K_JOCKEY  = 50
ELO_K_TRAINER = 50
ELO_INIT      = 1500

# ── EMA span for win-rate features ───────────────────────────────────────────
EMA_SPAN = 10

# ── Distance band tolerance (metres) ─────────────────────────────────────────
DIST_BAND = 200


# ── Feature column lists ──────────────────────────────────────────────────────

def get_feature_columns() -> list:
    return [
        # Raw continuous (all known before betting closes)
        "draw_norm", "act_wt_norm", "declar_wt_norm", "pool_norm",
        # Derived from pre-race columns only
        "days_since_last_norm", "wt_diff_norm",
        # Cumulative form — strictly past-data only via cumsum().shift(1)
        "horse_win_rate", "horse_place_rate", "horse_races_norm",
        "jockey_win_rate", "trainer_win_rate",
        # In-race relative (market signal — known pre-race)
        "odds_rank_norm", "draw_rank_norm", "odds_norm",
        # Categorical (label-encoded, low cardinality)
        "location_enc", "going_enc", "course_enc",
        # Crossed: draw × location × course
        "draw_loc_course_enc",
    ]


def get_categorical_columns() -> list:
    return ["location_enc", "going_enc", "course_enc", "draw_loc_course_enc"]


def get_numerical_columns() -> list:
    cats = set(get_categorical_columns())
    return [c for c in get_feature_columns() if c not in cats]


# ─────────────────────────────────────────────────────────────────────────────
# Public backwards-compat helper (used by predictor.py during backtest)
# ─────────────────────────────────────────────────────────────────────────────

def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Legacy helper: fit a fresh pipeline on `df` and return the features.
    Use FeaturePipeline directly for proper train/test separation.
    """
    return FeaturePipeline().fit_transform(df)


# ─────────────────────────────────────────────────────────────────────────────
# FeaturePipeline
# ─────────────────────────────────────────────────────────────────────────────

class FeaturePipeline:
    """
    Stateful feature transformer.  Fit on training data; transform test data
    with the SAME normalisation bounds and categorical codes.
    """

    def __init__(self):
        # Normalization: {feature_name: (min, max)}
        self._norm_params: Dict[str, tuple] = {}
        # Categorical codes: {col_name: {raw_value: int_code}}
        self._cat_codes: Dict[str, Dict[str, int]] = {}
        # ELO state after training (to warm-start for live inference)
        self._elo_state: Optional[dict] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def fit_transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """Fit pipeline on training data and return transformed features."""
        df = self._prepare(df)
        df = _add_cumulative_form(df)
        df = _add_weight_diff(df)
        df = _add_days_since_last(df)
        df = _add_race_relative(df)

        # Fit categorical encoders on training data
        self._fit_categorical(df)

        # Apply encoders
        df = self._apply_categorical(df)

        # Fit normalization on training data (after all features are computed)
        self._fit_norm(df)

        # Apply normalization
        df = self._apply_norm(df)

        return df

    def transform(
        self,
        df: pd.DataFrame,
        history_df: Optional[pd.DataFrame] = None,
    ) -> pd.DataFrame:
        """
        Transform test / live data using parameters fitted on training data.

        history_df : the raw historical training data (needed so rolling
                     stats for horses/jockeys/trainers can warm up before
                     the test rows are reached).
        """
        if history_df is not None:
            combined = pd.concat([history_df, df], ignore_index=True)
        else:
            combined = df.copy()

        combined = self._prepare(combined)
        combined = _add_cumulative_form(combined)
        combined = _add_weight_diff(combined)
        combined = _add_days_since_last(combined)
        combined = _add_race_relative(combined)

        # Apply TRAINING categorical codes (unknown → 0)
        combined = self._apply_categorical(combined)

        # Apply TRAINING normalization bounds
        combined = self._apply_norm(combined)

        # Return only the new rows (test / live portion)
        n_new = len(df)
        return combined.tail(n_new).reset_index(drop=True)

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self, path: str) -> None:
        with open(path, "wb") as f:
            pickle.dump({
                "norm_params": self._norm_params,
                "cat_codes":   self._cat_codes,
            }, f)

    @classmethod
    def load(cls, path: str) -> "FeaturePipeline":
        with open(path, "rb") as f:
            data = pickle.load(f)
        obj = cls()
        obj._norm_params = data["norm_params"]
        obj._cat_codes   = data["cat_codes"]
        return obj

    # ── Private helpers ───────────────────────────────────────────────────────

    def _prepare(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy().sort_values(
            ["date", "location", "race_no"]
        ).reset_index(drop=True)
        _ensure_won(df)
        return df

    # ── Categorical fit / apply ───────────────────────────────────────────────

    _CAT_SOURCE_COLS = {
        "location_enc":       "location",
        "going_enc":          "going",
        "course_enc":         "course",
        "draw_loc_course_enc": "_draw_loc_course",   # synthetic cross
    }

    def _fit_categorical(self, df: pd.DataFrame) -> None:
        """Build {value → int} maps from training data."""
        # Synthesize the cross-feature for fitting
        df = self._add_cross_col(df)
        for enc_col, src_col in self._CAT_SOURCE_COLS.items():
            if src_col not in df.columns:
                self._cat_codes[enc_col] = {}
                continue
            vals = sorted(df[src_col].dropna().astype(str).unique())
            # 0 is reserved for unknown / NaN → known values start at 1
            self._cat_codes[enc_col] = {v: i + 1 for i, v in enumerate(vals)}

    def _apply_categorical(self, df: pd.DataFrame) -> pd.DataFrame:
        df = self._add_cross_col(df)
        for enc_col, src_col in self._CAT_SOURCE_COLS.items():
            codes = self._cat_codes.get(enc_col, {})
            if src_col in df.columns:
                df[enc_col] = (
                    df[src_col].fillna("__NA__").astype(str)
                    .map(codes).fillna(0).astype(int)
                )
            else:
                df[enc_col] = 0
        return df

    @staticmethod
    def _add_cross_col(df: pd.DataFrame) -> pd.DataFrame:
        df["_draw_loc_course"] = (
            df.get("draw", pd.Series([0]*len(df), index=df.index)).fillna(0).astype(int).astype(str)
            + "_"
            + df.get("location", pd.Series(["?"]*len(df), index=df.index)).fillna("?").astype(str)
            + "_"
            + df.get("course", pd.Series(["?"]*len(df), index=df.index)).fillna("?").astype(str)
        )
        return df

    # ── Normalization fit / apply ─────────────────────────────────────────────

    _NORM_MAP = {
        "draw":            "draw_norm",
        "act_wt":          "act_wt_norm",
        "declar_wt":       "declar_wt_norm",
        "pool":            "pool_norm",
        "days_since_last": "days_since_last_norm",
        "wt_diff":         "wt_diff_norm",
        "horse_races":     "horse_races_norm",
    }

    def _fit_norm(self, df: pd.DataFrame) -> None:
        """Store min/max from training data only."""
        for src in self._NORM_MAP:
            if src in df.columns:
                col = df[src].fillna(df[src].median())
                self._norm_params[src] = (float(col.min()), float(col.max()))
            else:
                self._norm_params[src] = (0.0, 1.0)

    def _apply_norm(self, df: pd.DataFrame) -> pd.DataFrame:
        """Normalize using stored training min/max."""
        for src, dst in self._NORM_MAP.items():
            mn, mx = self._norm_params.get(src, (0.0, 1.0))
            if src in df.columns:
                col = df[src].fillna(df[src].median() if not df[src].isna().all() else 0.0)
            else:
                col = pd.Series(0.0, index=df.index)
            df[dst] = (col - mn) / (mx - mn + 1e-9)
            # Clip to reasonable range — test values outside training bounds
            # get clipped rather than extrapolated wildly
            df[dst] = df[dst].clip(-0.1, 1.1)
        return df


# ─────────────────────────────────────────────────────────────────────────────
# Feature computation functions (stateless — same logic as before)
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_won(df: pd.DataFrame) -> None:
    if "won" not in df.columns:
        if "place" in df.columns:
            df["won"] = (pd.to_numeric(df["place"], errors="coerce") == 1).astype(int)
        else:
            df["won"] = 0


# ── ELO ──────────────────────────────────────────────────────────────────────

def _add_elo(df: pd.DataFrame) -> pd.DataFrame:
    horse_elo:   Dict[str, float] = {}
    jockey_elo:  Dict[str, float] = {}
    trainer_elo: Dict[str, float] = {}

    h_col, j_col, t_col = [], [], []

    for _, race_df in df.groupby(["date", "location", "race_no"], sort=False):
        horses   = race_df["horse"].tolist()
        jockeys  = race_df["jockey"].tolist()
        trainers = race_df["trainer"].tolist()
        places   = race_df["place"].tolist()
        n = len(horses)

        pre_h = [horse_elo.get(h, ELO_INIT)   for h in horses]
        pre_j = [jockey_elo.get(j, ELO_INIT)  for j in jockeys]
        pre_t = [trainer_elo.get(t, ELO_INIT) for t in trainers]

        h_col.extend(pre_h)
        j_col.extend(pre_j)
        t_col.extend(pre_t)

        _update_elo(horses,   places, horse_elo,   ELO_K_HORSE,   pre_h, n)
        _update_elo(jockeys,  places, jockey_elo,  ELO_K_JOCKEY,  pre_j, n)
        _update_elo(trainers, places, trainer_elo, ELO_K_TRAINER, pre_t, n)

    df["horse_elo"]   = h_col
    df["jockey_elo"]  = j_col
    df["trainer_elo"] = t_col
    return df


def _update_elo(
    entities: list, places: list, elo_map: Dict[str, float],
    K: float, pre_elos: list, N: int,
) -> None:
    denom = N * (N - 1) / 2 if N > 1 else 1.0
    for idx, (entity, place) in enumerate(zip(entities, places)):
        try:
            p = int(float(place))
        except (TypeError, ValueError):
            continue
        S = (N - p) / denom
        R_x = pre_elos[idx]
        E_parts = [
            1.0 / (1.0 + 10 ** ((pre_elos[j] - R_x) / 400.0))
            for j in range(N) if j != idx
        ]
        E = sum(E_parts) / denom if E_parts else 0.5
        elo_map[entity] = R_x + K * (S - E)


# ── Rolling win rates (EMA, shift(1) so current outcome never leaks) ─────────

def _add_rolling_win_rates(df: pd.DataFrame) -> pd.DataFrame:
    for col, entity in [
        ("horse_wr",   "horse"),
        ("jockey_wr",  "jockey"),
        ("trainer_wr", "trainer"),
    ]:
        df[col] = (
            df.groupby(entity)["won"]
            .transform(lambda s: s.ewm(span=EMA_SPAN, adjust=False).mean().shift(1))
            .fillna(0.0)
        )
    return df


def _add_pair_win_rates(df: pd.DataFrame) -> pd.DataFrame:
    for col, pair in [
        ("jockey_horse_wr",  ["jockey", "horse"]),
        ("trainer_horse_wr", ["trainer", "horse"]),
    ]:
        df[col] = (
            df.groupby(pair)["won"]
            .transform(lambda s: s.ewm(span=EMA_SPAN, adjust=False).mean().shift(1))
            .fillna(0.0)
        )
    return df


# ── Condition-specific win rates ──────────────────────────────────────────────

def _add_condition_win_rates(df: pd.DataFrame) -> pd.DataFrame:
    df["dist_band"] = (
        pd.to_numeric(df["distance"], errors="coerce")
        .floordiv(DIST_BAND).mul(DIST_BAND).fillna(-1).astype(int)
    )
    df["horse_dist_wr"] = (
        df.groupby(["horse", "dist_band"])["won"]
        .transform(lambda s: s.ewm(span=EMA_SPAN, adjust=False).mean().shift(1))
        .fillna(0.0)
    )
    df["horse_going_wr"] = (
        df.groupby(["horse", "going"])["won"]
        .transform(lambda s: s.ewm(span=EMA_SPAN, adjust=False).mean().shift(1))
        .fillna(0.0)
    )
    return df


# ── Recent form ───────────────────────────────────────────────────────────────

def _add_recent_form(df: pd.DataFrame) -> pd.DataFrame:
    df["recent_form"] = (
        df.groupby("horse")["place"]
        .transform(lambda s: pd.to_numeric(s, errors="coerce")
                   .ewm(span=5, adjust=False).mean().shift(1))
        .fillna(7.0)
    )
    return df


# ── Cumulative form (strictly past-data only) ─────────────────────────────────

def _add_cumulative_form(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute per-horse / jockey / trainer win rates using only strictly past races.

    Uses cumsum().shift(1) — the current race's outcome is never visible to
    its own features.  Sorting by [date, location, race_no] (done in _prepare)
    guarantees chronological order within each group.
    """
    horse_key = "horse_id" if "horse_id" in df.columns else "horse"

    # ── prior race count (0 = first career start) ────────────────────────────
    df["horse_races"] = df.groupby(horse_key).cumcount()

    # ── cumulative wins & top-3 finishes BEFORE current race ─────────────────
    _ensure_won(df)
    df["_h_cum_wins"] = (
        df.groupby(horse_key)["won"]
        .transform(lambda s: s.cumsum().shift(1))
        .fillna(0)
    )
    df["_placed"] = (pd.to_numeric(df.get("place", pd.Series(dtype=float)),
                                   errors="coerce") <= 3).astype(float)
    df["_h_cum_places"] = (
        df.groupby(horse_key)["_placed"]
        .transform(lambda s: s.cumsum().shift(1))
        .fillna(0)
    )

    denom = df["horse_races"].clip(lower=1)
    df["horse_win_rate"]   = df["_h_cum_wins"]   / denom
    df["horse_place_rate"] = df["_h_cum_places"] / denom

    # ── jockey win rate ───────────────────────────────────────────────────────
    _jockey_races = df.groupby("jockey").cumcount().clip(lower=1)
    df["jockey_win_rate"] = (
        df.groupby("jockey")["won"]
        .transform(lambda s: s.cumsum().shift(1))
        .fillna(0)
    ) / _jockey_races

    # ── trainer win rate ──────────────────────────────────────────────────────
    _trainer_races = df.groupby("trainer").cumcount().clip(lower=1)
    df["trainer_win_rate"] = (
        df.groupby("trainer")["won"]
        .transform(lambda s: s.cumsum().shift(1))
        .fillna(0)
    ) / _trainer_races

    df.drop(columns=["_h_cum_wins", "_h_cum_places", "_placed"],
            inplace=True, errors="ignore")
    return df


# ── Weight diff & days since last ─────────────────────────────────────────────

def _add_weight_diff(df: pd.DataFrame) -> pd.DataFrame:
    df["wt_diff"] = (
        df.groupby("horse")["act_wt"]
        .transform(lambda s: pd.to_numeric(s, errors="coerce").diff())
        .fillna(0.0)
    )
    return df


def _add_days_since_last(df: pd.DataFrame) -> pd.DataFrame:
    df["days_since_last"] = (
        df.groupby("horse")["date"]
        .transform(lambda s: pd.to_datetime(s).diff().dt.days)
        .fillna(60.0)
        .clip(upper=600)
    )
    return df


# ── In-race relative features ─────────────────────────────────────────────────

def _add_race_relative(df: pd.DataFrame) -> pd.DataFrame:
    grp = df.groupby(["date", "location", "race_no"])
    df["odds_rank"]  = grp["win_odds"].rank(method="min")
    df["draw_rank"]  = grp["draw"].rank(method="min")
    odds_sum         = grp["win_odds"].transform("sum").replace(0, 1)
    df["odds_norm"]  = df["win_odds"] / odds_sum
    n_runners        = grp["horse"].transform("count")
    df["odds_rank_norm"] = df["odds_rank"] / n_runners
    df["draw_rank_norm"] = df["draw_rank"] / n_runners
    return df
