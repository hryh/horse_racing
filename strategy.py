"""
Betting Strategy
----------------
Kelly Criterion with fractional sizing for risk management.

Kelly formula for a win-only bet:
    f* = (b * p - q) / b
where
    b = decimal_odds - 1   (net profit per $1 bet)
    p = estimated win probability
    q = 1 - p

Fractional Kelly (fraction < 1) reduces bet size to limit variance.
Recommended: 0.25 (quarter Kelly) for live trading.

HKJC pari-mutuel: win_odds is the *dividend* for a $1 bet (i.e. decimal odds).
"""

from dataclasses import dataclass
from typing import Optional, Tuple
import numpy as np


@dataclass
class BetDecision:
    should_bet:   bool
    horse_idx:    Optional[int]   # row index within the race DataFrame
    horse_name:   Optional[str]
    win_prob:     float
    win_odds:     float           # HKJC closing odds (decimal)
    kelly_frac:   float           # raw Kelly fraction (can be negative)
    bet_fraction: float           # actual fraction of bankroll to bet
    expected_value: float         # (p * b - q), positive = profitable


class KellyCriterion:
    """
    Computes optimal bet size given model probability and market odds.

    Parameters
    ----------
    fractional_kelly : float
        Multiplier on full Kelly (0.25 = quarter-Kelly).  Lower = safer.
    min_edge : float
        Minimum expected value (EV) required to place a bet.
        EV = p * (odds-1) - (1-p).  Default 0.05 means at least 5 % edge.
    max_fraction : float
        Hard cap on fraction of bankroll bet per race.
    """

    def __init__(
        self,
        fractional_kelly: float = 0.25,
        min_edge:         float = 0.05,
        max_fraction:     float = 0.10,
    ):
        self.fractional_kelly = fractional_kelly
        self.min_edge         = min_edge
        self.max_fraction     = max_fraction

    def decide(
        self,
        horse_idx:  int,
        horse_name: str,
        win_prob:   float,
        win_odds:   float,     # HKJC decimal odds (e.g. 3.5 means +$3.50 per $1)
    ) -> BetDecision:
        """
        Returns a BetDecision for a single horse.
        """
        b = win_odds - 1.0     # net gain per $1
        p = win_prob
        q = 1.0 - p

        ev = p * b - q
        kelly = ev / b if b > 0 else 0.0

        if ev < self.min_edge or kelly <= 0:
            return BetDecision(
                should_bet=False,
                horse_idx=horse_idx,
                horse_name=horse_name,
                win_prob=p,
                win_odds=win_odds,
                kelly_frac=kelly,
                bet_fraction=0.0,
                expected_value=ev,
            )

        bet_frac = min(kelly * self.fractional_kelly, self.max_fraction)

        return BetDecision(
            should_bet=True,
            horse_idx=horse_idx,
            horse_name=horse_name,
            win_prob=p,
            win_odds=win_odds,
            kelly_frac=kelly,
            bet_fraction=bet_frac,
            expected_value=ev,
        )

    def simulate(
        self,
        decisions: list,           # list of BetDecision
        outcomes:  list,           # list of bool (True = horse won)
        bankroll:  float = 1000.0,
    ) -> dict:
        """
        Simulate betting on a sequence of races.

        Returns a dict with:
          final_bankroll, total_bets, wins, win_rate, roi, max_drawdown
        """
        bk = bankroll
        peak = bankroll
        max_dd = 0.0
        wins = 0
        n_bets = 0
        flat_profit = 0.0   # 1-unit flat stake per bet

        for dec, won in zip(decisions, outcomes):
            if not dec.should_bet:
                continue
            stake = bk * dec.bet_fraction
            n_bets += 1
            if won:
                bk += stake * (dec.win_odds - 1.0)
                flat_profit += (dec.win_odds - 1.0)
                wins += 1
            else:
                bk -= stake
                flat_profit -= 1.0
            peak = max(peak, bk)
            dd = (peak - bk) / peak
            max_dd = max(max_dd, dd)

        return {
            "final_bankroll": bk,
            "total_bets":     n_bets,
            "wins":           wins,
            "win_rate":       wins / n_bets if n_bets else 0.0,
            "roi":            (bk - bankroll) / bankroll,
            "flat_roi":       flat_profit / n_bets if n_bets else 0.0,
            "max_drawdown":   max_dd,
        }
