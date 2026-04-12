"""
Main Predictor
--------------
Ensemble of DNN (with confidence threshold) + Pattern Matching.

Usage
-----
# ── Train on historical data ────────────────────────────────────────────────
from horse_racing import HorseRacingPredictor
from horse_racing.data_fetcher import load_historical_csv

df = load_historical_csv("hkjc_results.csv")
predictor = HorseRacingPredictor()
predictor.fit(df)
predictor.save("models/")

# ── Live prediction ─────────────────────────────────────────────────────────
predictor = HorseRacingPredictor.load("models/")
from horse_racing.data_fetcher import get_race_card
card = get_race_card("2024-12-01", venue="HV")
decisions = predictor.predict_card(card)
"""

import os
import pickle
import numpy as np
import pandas as pd
from typing import Dict, List, Optional

from .features import FeaturePipeline, get_feature_columns
from .models   import DNNModel, PatternModel
from .strategy import KellyCriterion, BetDecision


# ---------------------------------------------------------------------------
# Harville QPL helpers
# ---------------------------------------------------------------------------

def _harville_qpl_prob(p: np.ndarray, i: int, j: int) -> float:
    """
    Compute P(horse i AND horse j both finish in top 3) using the Harville model.

    p: array of win probabilities (already normalized, sum = 1)
    i, j: 0-based indices of the two horses
    """
    n = len(p)
    others = [k for k in range(n) if k != i and k != j]

    pi, pj = float(p[i]), float(p[j])
    if pi <= 0 or pj <= 0:
        return 0.0

    total = 0.0

    # (i=1st, j=2nd)
    total += pi * pj / (1 - pi)

    # (j=1st, i=2nd)
    total += pj * pi / (1 - pj)

    for k in others:
        pk = float(p[k])
        if pk <= 0:
            continue
        denom_k = 1 - pk

        # (i=1st, j=3rd): i 1st, k 2nd, j 3rd
        dik = 1 - pi - pk
        if dik > 0:
            total += pi * (pk / (1 - pi)) * (pj / dik)

        # (j=1st, i=3rd): j 1st, k 2nd, i 3rd
        djk = 1 - pj - pk
        if djk > 0:
            total += pj * (pk / (1 - pj)) * (pi / djk)

        # (k=1st, i=2nd, j=3rd)
        dki = 1 - pk - pi
        if denom_k > 0 and dki > 0:
            total += pk * (pi / denom_k) * (pj / dki)

        # (k=1st, j=2nd, i=3rd)
        dkj = 1 - pk - pj
        if denom_k > 0 and dkj > 0:
            total += pk * (pj / denom_k) * (pi / dkj)

    return min(total, 1.0)


def compute_qpl_bets(
    decisions: List[BetDecision],
    kelly: KellyCriterion,
    qpl_market_odds: Optional[Dict] = None,
    top_n: int = 3,
) -> List[dict]:
    """
    Compute QPL pair recommendations for a race.

    decisions: sorted list of BetDecision from predict_race_df()
    kelly: KellyCriterion instance for bet sizing
    qpl_market_odds: {(runner_no_a, runner_no_b): market_odds} — optional
    top_n: how many pairs to return

    Returns list of dicts, best first.
    """
    probs = np.array([d.win_prob for d in decisions])
    if probs.sum() <= 0:
        return []
    probs = probs / probs.sum()

    n = len(decisions)
    results = []
    for i in range(n):
        for j in range(i + 1, n):
            qpl_prob = _harville_qpl_prob(probs, i, j)

            horse_a = decisions[i]
            horse_b = decisions[j]

            # Try to get market odds for EV calculation
            mkt_odds = None
            if qpl_market_odds:
                # Runner numbers are 1-based draw positions; try both orderings
                try:
                    na = int(horse_a.horse_idx) + 1
                    nb = int(horse_b.horse_idx) + 1
                    key = (min(na, nb), max(na, nb))
                    mkt_odds = qpl_market_odds.get(key)
                except (TypeError, ValueError):
                    pass

            ev = None
            bet_fraction = 0.0
            should_bet = False
            if mkt_odds and mkt_odds > 0:
                ev = round(qpl_prob * mkt_odds - 1, 4)
                if ev > kelly.min_edge:
                    # Kelly fraction for QPL
                    raw_kelly = ev / (mkt_odds - 1) if mkt_odds > 1 else 0
                    bet_fraction = min(raw_kelly * kelly.fractional_kelly, kelly.max_fraction)
                    should_bet = bet_fraction > 0

            results.append({
                "horse_a":     horse_a.horse_name,
                "horse_b":     horse_b.horse_name,
                "qpl_prob":    round(qpl_prob, 4),
                "market_odds": mkt_odds,
                "ev":          ev,
                "should_bet":  should_bet,
                "bet_fraction": round(bet_fraction * 100, 2) if should_bet else None,
            })

    # Sort: if market odds available, sort by EV desc; otherwise by probability desc
    if qpl_market_odds:
        results.sort(key=lambda x: (x["ev"] or -99), reverse=True)
    else:
        results.sort(key=lambda x: x["qpl_prob"], reverse=True)

    return results[:top_n]


class HorseRacingPredictor:
    """
    Ensemble predictor:  final_prob = dnn_weight * P_dnn + pattern_weight * P_pattern

    The FeaturePipeline is fit on training data and its normalisation/encoding
    parameters are stored so that test and live data are transformed with the
    exact same scaling — eliminating the main source of historical bias.
    """

    def __init__(
        self,
        dnn_weight:       float = 0.65,
        pattern_weight:   float = 0.35,
        dnn_threshold:    float = 0.25,
        dnn_epochs:       int   = 300,
        kelly_frac:       float = 0.25,
        min_edge:         float = 0.05,
        max_bet_fraction: float = 0.10,
    ):
        self.dnn_weight     = dnn_weight
        self.pattern_weight = pattern_weight
        self.dnn_threshold  = dnn_threshold
        self.dnn_epochs     = dnn_epochs

        self.dnn      = DNNModel(confidence_threshold=dnn_threshold)
        self.pattern  = PatternModel(k=12)
        self.kelly    = KellyCriterion(
            fractional_kelly=kelly_frac,
            min_edge=min_edge,
            max_fraction=max_bet_fraction,
        )
        self.pipeline: Optional[FeaturePipeline] = None
        self._raw_train_df: Optional[pd.DataFrame] = None   # kept for backtest warm-up

    # -----------------------------------------------------------------------
    # Training
    # -----------------------------------------------------------------------

    def fit(self, df: pd.DataFrame, verbose: int = 1,
            checkpoint_dir: str = None) -> None:
        """
        Build all features then train both models.

        df             : raw historical DataFrame from load_historical_csv().
        checkpoint_dir : if set, save best DNN weights here during training.
        """
        self._raw_train_df = df.copy()

        if verbose:
            print("[predictor] Building features (fit on training data) …")
        self.pipeline = FeaturePipeline()
        feat_df = self.pipeline.fit_transform(df)

        if verbose:
            print(f"[predictor] Training DNN for {self.dnn_epochs} epochs …")
        ckpt_path = (
            os.path.join(checkpoint_dir, "dnn", "dnn_model.keras")
            if checkpoint_dir else None
        )
        self.dnn.fit(feat_df, epochs=self.dnn_epochs, verbose=verbose,
                     checkpoint_path=ckpt_path)

        if verbose:
            print("[predictor] Building Pattern Matching index …")
        self.pattern.build_index(feat_df)

        if verbose:
            print("[predictor] Done.")

    # -----------------------------------------------------------------------
    # Prediction for a pre-engineered race DataFrame
    # -----------------------------------------------------------------------

    def predict_race_df(
        self,
        race_feat_df: pd.DataFrame,
        close_odds: Optional[Dict[str, float]] = None,
    ) -> List[BetDecision]:
        """
        Predict win probabilities and betting decisions for one race.
        Returns list of BetDecision sorted by win_prob descending.
        """
        p_dnn     = self.dnn.predict_race(race_feat_df)
        p_pattern = self.pattern.predict_race(race_feat_df)
        p_ensemble = (self.dnn_weight * p_dnn + self.pattern_weight * p_pattern)
        p_ensemble = p_ensemble / p_ensemble.sum()

        dnn_best_conf  = float(p_dnn.max())
        above_threshold = dnn_best_conf >= self.dnn_threshold

        decisions = []
        for i, row in enumerate(race_feat_df.itertuples()):
            horse_name = getattr(row, "horse", f"Horse_{i}")
            if close_odds and horse_name in close_odds:
                odds = float(close_odds[horse_name])
            elif hasattr(row, "win_odds"):
                try:
                    odds = float(row.win_odds)
                    if np.isnan(odds):
                        odds = 1.0
                except (TypeError, ValueError):
                    odds = 1.0
            else:
                odds = 1.0

            prob = float(p_ensemble[i])

            if above_threshold:
                dec = self.kelly.decide(i, horse_name, prob, odds)
            else:
                dec = BetDecision(
                    should_bet=False, horse_idx=i, horse_name=horse_name,
                    win_prob=prob, win_odds=odds, kelly_frac=0.0,
                    bet_fraction=0.0, expected_value=0.0,
                )
            decisions.append(dec)

        decisions.sort(key=lambda d: d.win_prob, reverse=True)
        return decisions

    # -----------------------------------------------------------------------
    # Live prediction from HKJC API response
    # -----------------------------------------------------------------------

    def predict_card(
        self,
        card: dict,
        history_df: Optional[pd.DataFrame] = None,
    ) -> List[dict]:
        """
        Predict all races in a live race card.
        Uses the fitted pipeline to transform features consistently with training.
        """
        if self.pipeline is None:
            raise RuntimeError("Call fit() before predicting.")

        base_raw = history_df if history_df is not None else self._raw_train_df
        if base_raw is None:
            raise RuntimeError("No training history available. Call fit() first.")

        # Build all rows for all races at once, then transform in a single pass.
        # Calling transform() once instead of N times avoids re-concatenating and
        # re-processing the full training history for every race (11× speedup).
        all_rows: list = []
        race_slices: list = []  # (race_no, race_dict, start_idx, end_idx)

        for race in card.get("races", []):
            race_no = race.get("race_no")
            runners = race.get("runners", [])
            if not runners:
                continue
            start = len(all_rows)
            for r in runners:
                all_rows.append({
                    "date": pd.Timestamp(card["date"]),
                    "location": card["venue"], "race_no": race_no,
                    "class": race.get("class", ""),
                    "distance": race.get("distance"),
                    "going": race.get("going", ""),
                    "course": race.get("course", ""),
                    "pool": race.get("pool"),
                    "horse": r.get("horse"), "horse_id": r.get("horse_id"),
                    "jockey": r.get("jockey"), "trainer": r.get("trainer"),
                    "act_wt": r.get("act_wt"), "declar_wt": r.get("declar_wt"),
                    "draw": r.get("draw"), "win_odds": r.get("win_odds"),
                    "place": None, "won": 0, "lbw": None, "time": None,
                })
            race_slices.append((race_no, race, start, len(all_rows)))

        if not all_rows:
            return []

        # Single transform call for the entire card
        all_feat = self.pipeline.transform(
            pd.DataFrame(all_rows), history_df=base_raw
        )

        results = []
        for race_no, race, start, end in race_slices:
            feat    = all_feat.iloc[start:end].reset_index(drop=True)
            runners = race.get("runners", [])
            close_odds = {
                r.get("horse"): r.get("win_odds")
                for r in runners if r.get("win_odds")
            }
            decisions = self.predict_race_df(feat, close_odds=close_odds)
            best_bet  = next((d for d in decisions if d.should_bet), None)
            results.append({
                "race_no":   race_no,
                "venue":     card["venue"],
                "date":      card["date"],
                "decisions": decisions,
                "best_bet":  best_bet,
            })

        return results

    # -----------------------------------------------------------------------
    # Back-test on held-out data
    # -----------------------------------------------------------------------

    def backtest(
        self,
        test_df: pd.DataFrame,
        history_df: pd.DataFrame,
        verbose: int = 1,
    ) -> dict:
        """
        Simulate betting on test_df using the fitted pipeline.
        history_df is raw training data (used to warm up rolling stats).
        No test data statistics are allowed to influence feature computation.
        """
        if self.pipeline is None:
            raise RuntimeError("Call fit() before backtesting.")

        # Transform test features using training-fitted pipeline
        feat_test = self.pipeline.transform(test_df, history_df=history_df)

        all_decisions: List[BetDecision] = []
        all_outcomes:  List[bool]        = []

        for _, race_df in feat_test.groupby(
            ["date", "location", "race_no"], sort=True
        ):
            decisions = self.predict_race_df(race_df)
            best = next((d for d in decisions if d.should_bet), None)
            if best is None:
                continue

            winner_horse = race_df[race_df["won"] == 1]["horse"]
            won = (
                not winner_horse.empty
                and winner_horse.iloc[0] == best.horse_name
            )
            all_decisions.append(best)
            all_outcomes.append(won)

        stats = self.kelly.simulate(all_decisions, all_outcomes)
        if verbose:
            print(
                f"[backtest] Bets: {stats['total_bets']}  "
                f"Win rate: {stats['win_rate']:.3f}  "
                f"Flat ROI: {stats['flat_roi']*100:.1f}%  "
                f"Max DD: {stats['max_drawdown']:.3f}"
            )
        return stats

    # -----------------------------------------------------------------------
    # Persistence
    # -----------------------------------------------------------------------

    def save(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)
        self.dnn.save(os.path.join(path, "dnn"))
        self.pattern.save(os.path.join(path, "pattern"))
        if self.pipeline is not None:
            self.pipeline.save(os.path.join(path, "pipeline.pkl"))
        meta = {
            "dnn_weight":     self.dnn_weight,
            "pattern_weight": self.pattern_weight,
            "dnn_threshold":  self.dnn_threshold,
            "dnn_epochs":     self.dnn_epochs,
            "kelly":          self.kelly,
        }
        with open(os.path.join(path, "predictor_meta.pkl"), "wb") as f:
            pickle.dump(meta, f)
        if self._raw_train_df is not None:
            self._raw_train_df.to_parquet(os.path.join(path, "raw_train_df.parquet"))
        print(f"[predictor] Saved to {path}")

    @classmethod
    def load(cls, path: str) -> "HorseRacingPredictor":
        with open(os.path.join(path, "predictor_meta.pkl"), "rb") as f:
            meta = pickle.load(f)
        obj = cls(
            dnn_weight=meta["dnn_weight"],
            pattern_weight=meta["pattern_weight"],
            dnn_threshold=meta["dnn_threshold"],
            dnn_epochs=meta["dnn_epochs"],
        )
        obj.kelly   = meta["kelly"]
        obj.dnn     = DNNModel.load(os.path.join(path, "dnn"))
        obj.pattern = PatternModel.load(os.path.join(path, "pattern"))

        pipeline_path = os.path.join(path, "pipeline.pkl")
        if os.path.exists(pipeline_path):
            obj.pipeline = FeaturePipeline.load(pipeline_path)

        raw_path = os.path.join(path, "raw_train_df.parquet")
        if os.path.exists(raw_path):
            obj._raw_train_df = pd.read_parquet(raw_path)

        print(f"[predictor] Loaded from {path}")
        return obj
